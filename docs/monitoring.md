# Monitoring & observability (Prometheus + Grafana)

The control plane exposes Prometheus metrics on **`GET /metrics`** (open,
loopback-only like `/health`) and emits **structured run-lifecycle logs**. Both
are hand-rolled (no `prom-client` dependency), in `modules/metrics/{prometheus,runtime}.ts`.

## Metrics on `/metrics`

**Business (computed on scrape, `modules/metrics/prometheus.ts`)**

- `shieldtest_campaigns{status}` — campaigns by status
- `shieldtest_runs_total` — total recorded runs
- `shieldtest_wrs_last{target}` — last WRS per target

**Runtime / operational (live, `modules/metrics/runtime.ts`)** — the signals
that make an incident diagnosable at runtime:

| Metric                                                                                    | Type    | Labels                | What it tells you                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `shieldtest_http_requests_total`                                                          | counter | `method,route,status` | API throughput & error rates by route                                                                                                 |
| `shieldtest_http_request_duration_ms`                                                     | summary | `method,route`        | API latency (`_sum`/`_count` → avg)                                                                                                   |
| `shieldtest_runs_in_flight`                                                               | gauge   | —                     | campaign runs currently executing                                                                                                     |
| `shieldtest_runs_completed_total`                                                         | counter | `status,engine`       | runs by terminal status                                                                                                               |
| `shieldtest_run_duration_seconds`                                                         | summary | `engine`              | wall-clock run duration                                                                                                               |
| `shieldtest_run_wrs_last`                                                                 | gauge   | `target`              | last WRS per target                                                                                                                   |
| `shieldtest_run_configured_rps_last`                                                      | gauge   | `target`              | configured max RPS of the last run (**what we asked for**)                                                                            |
| `shieldtest_run_achieved_rps_last`                                                        | gauge   | `target`              | RPS actually sent (**offered load**)                                                                                                  |
| `shieldtest_run_origin_rps_last`                                                          | gauge   | `target`              | RPS that reached origin — 2xx/3xx (**let through**)                                                                                   |
| `shieldtest_run_absorbed_ratio_last`                                                      | gauge   | `target`              | `failed/total` = **fraction the target edge absorbed** (rate-limited/tarpitted/4xx). The test↔protection loop, per run                 |
| `shieldtest_loadtest_hard_stopped_total`                                                  | counter | `target,engine`       | runs force-settled by the engine **hard backstop** — a target holding connections open past the cap (tarpit / undici pool exhaustion) |
| `shieldtest_eventloop_lag_ms` / `_p99_ms`                                                 | gauge   | —                     | event-loop delay (a spike here is what briefly makes the API unreachable under heavy load)                                            |
| `shieldtest_process_heap_used_bytes` / `_rss_bytes` / `shieldtest_process_uptime_seconds` | gauge   | —                     | process health                                                                                                                        |

## Structured logs

Each run emits pino JSON events (captured by journald / the log sink):

- `run.start` — `campaignId, campaign, target, engine, maxRps, maxDurationSec, phases`
- `run.settled` — `campaignId, runId, target, status, statusDetail, wrs, grade, durationSec, requests, successful, failed, actualRps, configuredRps`

A stuck run is obvious (it logs `run.start` but never `run.settled`), and every
run is fully traceable. `journalctl -u ddostester | grep run.settled` gives a
per-run audit trail.

## Deploying a stack

### Option A — single host (Docker profile, control plane + monitoring together)

```bash
POSTGRES_PASSWORD=... GRAFANA_PASSWORD=... \
  docker compose --profile monitoring up -d --build
```

Prometheus scrapes `api:8080/metrics` on the internal network; Grafana on
`127.0.0.1:3000` (SSH tunnel) with an auto-provisioned datasource and dashboard
(`deploy/monitoring/grafana/dashboards/shieldtest.json`).

### Option B — split deploy (VPS 1 control plane + VPS 2 lab runner)

For the 4-VPS topology (see [provisioning-4vps.md](./provisioning-4vps.md)) the
monitoring stack runs **native on VPS 2** and scrapes the VPS 1 control plane
through the **existing SSH tunnel** the lab runner already holds
(`127.0.0.1:8080 → VPS1:8080`) — so no new inbound surface is opened and the
lab's fail-closed isolation is preserved. Provision with
`deploy/provision/host-monitoring.sh` (node_exporter + Prometheus + Grafana, all
loopback-bound):

```bash
# as root on VPS 2:
bash deploy/provision/host-monitoring.sh
# from your machine (Grafana + Prometheus over a tunnel):
ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 root@<VPS2>
```

Prometheus scrapes: the control-plane `/metrics` (via the tunnel), the VPS 2
`node_exporter`, and itself. Nothing is exposed publicly — reach Grafana
(`127.0.0.1:3000`) only over the SSH tunnel, and change the default `admin`
password on first login.

## Alerting

`deploy/provision/host-alerting.sh` (run on VPS 2) installs **Alertmanager**
(loopback), ships `alert.rules.yml`, and wires Prometheus → rules → Alertmanager.
Optionally forwards to Rocket.Chat (`RC_WEBHOOK=… bash host-alerting.sh`); without
it, alerts still fire and are visible in the Alertmanager UI
(`ssh -L 9093:127.0.0.1:9093 root@31.31.74.187`).

The rule set turns the metrics above into signals:

| Alert                     | Fires when                                                        | Why it matters                                              |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `TargetTarpittingRuns`    | `increase(loadtest_hard_stopped_total[15m]) > 0`                  | the target edge is holding our runs past the cap (biting)   |
| `WRSDrop`                 | `run_wrs_last < 70`                                               | protection degraded, or a template misbehaving              |
| `ProtectionNotEngaging`   | `run_absorbed_ratio_last < 0.05`                                  | almost everything reached origin (edge not engaging)        |
| `CampaignRunsFailing`     | `increase(runs_completed_total{status="failed"}[15m]) > 0`       | a template broke or the target is unreachable               |
| `ControlPlaneEventLoopLag`| `eventloop_lag_p99_ms > 200` for 5m                              | VPS 1 is the bottleneck — WRS/achieved-RPS understated      |
| `RunsInFlightSaturated`   | `runs_in_flight >= 5` for 10m                                     | capacity/scheduling pressure on VPS 1                       |
| `ControlPlaneDown`        | `up{job="shieldtest-control-plane"} == 0` for 2m                 | app down or tunnel broken                                   |
| `MonitoringTargetDown`    | `up == 0` for 5m                                                  | a scrape target is unreachable                              |

The Grafana dashboard (provisioned by `grafana-setup.mjs`) has a **protection
absorption** row: configured-vs-sent-vs-origin RPS, a **% absorbed** gauge, and
firing-alert panels driven by the `ALERTS` series.

## Without a stack

Point an existing Prometheus at `http://<loopback-host>:8080/metrics` and import
`deploy/monitoring/grafana/dashboards/shieldtest.json` into Grafana.
