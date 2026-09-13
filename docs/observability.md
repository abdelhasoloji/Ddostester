# Observability & notifications

Observability is a first-class pillar: the product _is_ measurement, so the
trustworthiness of that measurement matters as much as the numbers. The control
plane exposes Prometheus metrics on **`GET /metrics`** and emits structured
run-lifecycle logs (both hand-rolled, no `prom-client`, in
`backend/src/modules/metrics/{prometheus,runtime}.ts`); a Prometheus/Grafana/Loki
stack runs on VPS 2. Deploy topology is in [operations.md](./operations.md).

---

## 1. The three planes

Organised by **who is asking what**; each plane is one Grafana dashboard (folder
`ShieldTest`) deep-linked from the matching app surface.

| Plane                                           | Question                                     | Dashboard                                                                                                                           | Anchored in                  |
| ----------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **1 · Run & Absorption** (tactical/live)        | "What's happening **now** on this run?"      | `shieldtest-run` — offered / reached-origin RPS, absorbed %, legit-probe uptime, updated every tick; live gauges retired at run end | **Run Theater**              |
| **2 · Resilience** (product signal/historical)  | "Are we getting **more resilient**?"         | `shieldtest-resilience` — WRS over time by target/vector, absorption trend, leak-through, targets below threshold                   | **Results**                  |
| **3 · Platform Health** (instrument health/SRE) | "Is the **measurement itself** trustworthy?" | `shieldtest-platform` — API rate/error/latency by route, event-loop lag, memory, uptime                                             | **Settings → Observability** |

A degraded control plane invalidates measurements, so Plane 3 guards the other
two. Prometheus reaches the control plane through the existing VPS 2 → VPS 1 SSH
tunnel; everything binds loopback (fail-closed).

## 2. `/metrics` — the surface

**Business** (`prometheus.ts`): `shieldtest_campaigns{status}`,
`shieldtest_runs_total`, `shieldtest_wrs_last{target}`.

**Runtime / operational** (`runtime.ts`) — the signals that make an incident
diagnosable:

| Metric                                                                  | Type    | Tells you                                                          |
| ----------------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `shieldtest_http_requests_total{method,route,status}`                   | counter | API throughput & error rates                                       |
| `shieldtest_http_request_duration_ms{method,route}`                     | summary | API latency                                                        |
| `shieldtest_runs_in_flight`                                             | gauge   | runs currently executing                                           |
| `shieldtest_runs_completed_total{status,engine}`                        | counter | runs by terminal status                                            |
| `shieldtest_run_{configured,achieved,origin}_rps_last{target,vector}`   | gauge   | asked-for / offered / reached-origin RPS                           |
| `shieldtest_run_absorbed_ratio_last{target,vector}`                     | gauge   | fraction the edge absorbed (the test↔protection loop)              |
| `shieldtest_run_{rejected,tarpit,offered_shortfall}_ratio_last`         | gauge   | edge rejected (fast no) / tarpitted (slow no) / backpressure       |
| `shieldtest_loadtest_hard_stopped_total{target,engine}`                 | counter | runs force-settled by the hard backstop (tarpit / pool exhaustion) |
| `shieldtest_eventloop_lag_ms` / `_p99_ms`                               | gauge   | event-loop delay (measurement confidence)                          |
| `shieldtest_process_heap_used_bytes` / `_rss_bytes` / `_uptime_seconds` | gauge   | process health                                                     |

`/metrics` is open but loopback-only like `/health` (no auth — non-sensitive
aggregates; protect via the proxy if exposed).

## 3. Structured logs

Each run emits pino JSON: `run.start` (`campaignId, campaign, target, engine,
maxRps, maxDurationSec, phases`) and `run.settled` (`campaignId, runId, target,
status, statusDetail, wrs, grade, durationSec, requests, successful, failed,
actualRps, configuredRps`). A stuck run is obvious (start with no settled).
`journalctl -u ddostester | grep run.settled` = a per-run trail. **Loki +
Promtail** (VPS 2, `deploy/provision/host-loki.sh`) put logs next to metrics; drill
a WRS drop straight to the run's log lines via the `runId` field.

## 4. Alerts — one threshold set, two surfaces

The in-app **notification bell** (`backend/src/modules/alerts/derive.ts`) and the
Prometheus/Alertmanager rules
(`deploy/monitoring/prometheus/shieldtest.rules.yml`) mirror each other:

| Signal                      | Threshold                                             | In app                                     | Prometheus              |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------ | ----------------------- |
| Low WRS                     | `< 70`                                                | `LOW_WRS_THRESHOLD`                        | `LowWRS`                |
| Tarpitting                  | tarpit ratio `> 0.5`                                  | `tarpit`                                   | `TarpitDominant`        |
| Degraded measurement        | event-loop p99 `> 200 ms`                             | `degraded`                                 | `MeasurementDegraded`   |
| Target tarpitting runs      | `increase(loadtest_hard_stopped_total[15m]) > 0`      | —                                          | `TargetTarpittingRuns`  |
| Protection not engaging     | absorbed `< 0.05`                                     | —                                          | `ProtectionNotEngaging` |
| Control plane down          | `up == 0` for 2m                                      | —                                          | `ControlPlaneDown`      |
| WRS / protection regression | ≥ 12 pts below baseline / absorbed < 50 % of baseline | `wrs-regression` / `protection-regression` | _app-only¹_             |

¹ The regression signals need a stateful per-target baseline, so they stay
app-derived; everything expressible as a stateless threshold is mirrored in
Prometheus. Alertmanager (`deploy/provision/host-alerting.sh`) can forward to
Rocket.Chat.

## 5. App-native charts

Beyond deep-linking Grafana, the app renders **its own** charts from the same
Prometheus via a bounded, read-only proxy
`GET /api/metrics/range?series=<key>&target=<host>&minutes=&step=` — a **named
series** from a reviewed catalogue (`series-catalog.ts`), never raw PromQL (no
injection/SSRF). Rendered with **uPlot**. Fail-soft: without `PROMETHEUS_URL` (or
Prometheus unreachable) the endpoint returns `source: "unavailable"` and the UI
hides the chart. First use: the **Live RPS** chart in Run Theater.

## 6. Provisioning (one command per host, all loopback)

```bash
bash deploy/provision/host-monitoring.sh    # Prometheus + Grafana + 3 dashboards + datasources + rules
bash deploy/provision/host-alerting.sh      # Alertmanager
GRAFANA_PASS=… bash deploy/provision/host-loki.sh   # Loki + Promtail
```

Reach Grafana over a tunnel (`ssh -L 3000:127.0.0.1:3000 …`) then set the URL in
**Settings → Observability**, or behind the mTLS edge (a Caddy `/grafana` handler
proxying to Grafana over the VPS 1 → VPS 2 tunnel). Without a stack: point any
Prometheus at `http://<loopback-host>:8080/metrics` and import
`deploy/monitoring/grafana/dashboards/shieldtest.json`.

---

## 7. Notifications (team push, opt-in)

Opt-in — with no sink configured, nothing is sent (`backend/src/modules/notify/`).

| Event                | When                                                                       | Severity           |
| -------------------- | -------------------------------------------------------------------------- | ------------------ |
| `campaign.completed` | a run finished normally                                                    | info               |
| `campaign.killed`    | a run hit the kill switch                                                  | critical / warning |
| `wrs.regression`     | WRS dropped > 10 pts vs the last run                                       | warning            |
| `baseline.drift`     | nominal baseline degraded (availability −≥5 pts, or p95 +≥25 % and ≥20 ms) | warning            |

Each carries campaign name, target, engine, WRS + level, request/failure counts,
probe availability. **Sinks**: Slack incoming webhook (coloured by severity) and
a generic JSON webhook (`{ product, kind, severity, title, text, at, campaignId,
fields }`); `http`/`https` only, best-effort, 5 s timeout (a failing sink is
logged, never propagated). Configure via `NOTIFY_SLACK_WEBHOOK_URL`,
`NOTIFY_WEBHOOK_URL`, optional `NOTIFY_EVENTS` / `NOTIFY_TIMEOUT_MS`. `/health`
returns sink **names** only (never URLs). Verify: **Settings → Notifications →
Send test**, or `POST /api/notify/test`.
