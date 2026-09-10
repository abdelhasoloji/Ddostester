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

## Without a stack

Point an existing Prometheus at `http://<loopback-host>:8080/metrics` and import
`deploy/monitoring/grafana/dashboards/shieldtest.json` into Grafana.
