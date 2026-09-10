# Observability — the structured model

Observability is a **first-class pillar** of ShieldTest, not an afterthought:
the product _is_ measurement, so the trustworthiness and history of that
measurement matter as much as the numbers themselves. This page defines the
**logical structure** — what we observe, where it lives, and how the app, the
dashboards and the alerts stay one coherent system.

See also [monitoring.md](./monitoring.md) for the raw `/metrics` surface and the
host provisioning scripts.

## Where things run

| Component                     | Host  | Bind             | Source of truth                                                         |
| ----------------------------- | ----- | ---------------- | ----------------------------------------------------------------------- |
| Control plane `/metrics`      | VPS 1 | loopback `:8080` | `modules/metrics/{prometheus,runtime}.ts`                               |
| Prometheus (scrape + rules)   | VPS 2 | loopback `:9090` | `deploy/monitoring/prometheus/` + `deploy/provision/host-monitoring.sh` |
| Grafana (dashboards + alerts) | VPS 2 | loopback `:3000` | `deploy/monitoring/grafana/` (provisioned)                              |
| Loki + Promtail (logs)        | VPS 2 | loopback `:3100` | `deploy/provision/host-loki.sh`                                         |
| Alertmanager                  | VPS 2 | loopback `:9093` | `deploy/provision/host-alerting.sh`                                     |

Prometheus reaches the control plane through the **existing VPS 2 → VPS 1 SSH
tunnel** (`127.0.0.1:8080`). Everything binds loopback (fail-closed); reach
Grafana from a workstation with a tunnel, or expose it behind the mTLS edge (see
[Exposure](#exposure)).

## The three planes

Observability is organised by **who is asking what**. Each plane is one Grafana
dashboard (folder `ShieldTest`), and each is deep-linked from the matching place
in the app (Settings → Observability, or the ↗ buttons).

### Plane 1 · Run & Absorption — _tactical / live_

> "What is happening **right now** on this run?"

`shieldtest-run` — offered / reached-origin RPS, absorbed % and legit-probe
availability **updated every tick** from the in-flight run (the
`shieldtest_run_live_*` gauges, mirroring the app's Run Theater), plus the
settle-time absorption decomposition (absorbed / rejected / tarpit /
offered-shortfall) and WRS. The live gauges are retired when the run ends, so a
finished run leaves no stale line. Grafana samples them at the Prometheus scrape
interval, so it is real-time at that resolution — the app's SSE Run Theater
stays the per-second view. Anchored in **Run Theater**.

### Plane 2 · Resilience — _product signal / historical_

> "Are we getting **more resilient**?"

`shieldtest-resilience` — WRS over time by target/vector, absorption trend,
leak-through (reached-origin vs offered), targets below the alert threshold, and
a latest-snapshot table. Anchored in **Results**.

### Plane 3 · Platform Health — _instrument health / SRE_

> "Is the **measurement itself** trustworthy?"

`shieldtest-platform` — API request rate / error rate / latency by route,
event-loop lag (measurement confidence), process memory, uptime, throughput. A
degraded control plane invalidates measurements, so this plane guards the other
two. Anchored in **Settings → Observability**.

## Alerts — one set of thresholds, two surfaces

The in-app **notification bell** (`modules/alerts/derive.ts`) and the
Prometheus/Alertmanager rules (`deploy/monitoring/prometheus/shieldtest.rules.yml`)
deliberately mirror each other, so an operator sees the same story in the app and
in Grafana:

| Signal                | Threshold                            | In app (`derive.ts`)    | Prometheus rule       |
| --------------------- | ------------------------------------ | ----------------------- | --------------------- |
| Low WRS               | `< 70`                               | `LOW_WRS_THRESHOLD`     | `LowWRS`              |
| Tarpitting            | tarpit ratio `> 0.5`                 | `tarpit`                | `TarpitDominant`      |
| Degraded measurement  | event-loop p99 `> 200 ms`            | `degraded`              | `MeasurementDegraded` |
| WRS regression        | `≥ 12` pts below baseline (≥ 4 runs) | `wrs-regression`        | _app-only¹_           |
| Protection regression | absorbed `< 50%` of baseline         | `protection-regression` | _app-only¹_           |

¹ The regression signals need a **per-target baseline** (a rolling mean of prior
runs), which is stateful; they stay app-derived rather than being forced into a
stateless PromQL threshold. Everything directly expressible as a threshold is
mirrored in Prometheus.

## Logs ↔ metrics

Loki holds the structured `run.start` / `run.settled` pino logs (shipped by
Promtail). With the Loki datasource wired into Grafana, a WRS drop on Plane 2 can
be drilled straight through to the exact run's log lines. Promtail on VPS 2
scrapes this host; shipping VPS 1's journal into the same Loki is a documented
follow-up in `host-loki.sh`.

## App-native charts (option B)

Beyond deep-linking into Grafana, the app can render **its own** charts from the
**same** Prometheus, so a graph in the app reads like a Grafana panel without
embedding Grafana. The backend exposes a bounded, read-only proxy
`GET /api/metrics/range?series=<key>&target=<host>&minutes=&step=` — the client
asks for a **named series** from a reviewed catalogue (`series-catalog.ts`),
never raw PromQL, so there is no query injection or SSRF surface. The frontend
renders it with **uPlot** (the engine Grafana itself uses). It is fail-soft:
without `PROMETHEUS_URL` (or when Prometheus is unreachable) the endpoint returns
`source: "unavailable"` and the UI hides the native chart. Prometheus is loopback
on VPS 2, so `PROMETHEUS_URL` points at a VPS 1 → VPS 2 tunnel in production.
First use: the **Live RPS** chart in Run Theater.

## Exposure

Grafana binds loopback. Two ways to reach it:

1. **Per-operator tunnel** (quick):
   `ssh -L 3000:127.0.0.1:3000 root@31.31.74.187` → `http://localhost:3000`,
   then set that URL in **Settings → Observability**.
2. **mTLS edge route** (shared): a Caddy `/grafana` handler on VPS 1 reverse-
   proxies to Grafana over a VPS 1 → VPS 2 tunnel, with Grafana's
   `root_url` + `serve_from_sub_path` set — reachable like the console, behind
   the same client certificate. This is the target state.

## Provisioning (one command per host)

```bash
# VPS 2 — Prometheus + Grafana + the 3 dashboards + datasources + alert rules
bash deploy/provision/host-monitoring.sh
# VPS 2 — Alertmanager (routes the Prometheus rules)
bash deploy/provision/host-alerting.sh
# VPS 2 — Loki + Promtail (logs next to metrics)
GRAFANA_PASS=… bash deploy/provision/host-loki.sh
```

Dashboards are file-provisioned and hot-reload (~10 s); datasource and alerting
changes are applied on a Grafana/Prometheus restart.
