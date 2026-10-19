# Phase 1 MVP — measured results

19 October 2026. What was run, on what, and what the numbers mean. Everything here
comes from the compiled engine and the real HTTP API on this workstation; nothing is
extrapolated from a unit test.

## Environment

| Item             | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Host             | macOS workstation (arm64)                                                |
| API              | `USER_MODE=team CAMPAIGN_CATALOG=legacy`, in-memory store, auth disabled |
| Target           | local Node HTTP server on `127.0.0.1:8099` (responds `200 ok`)           |
| High-rate engine | `vegeta` 12.13.0                                                         |
| Commit           | `017ac45` (`codex/zerobs-classic-three-pods` → see git log)              |

## 1. Endurance at 1,000 rps — `endurance-1000rps-180s.json`

Direct engine run, 180 s, concurrency 100, loopback target.

| Metric                         | Value                                     |
| ------------------------------ | ----------------------------------------- |
| Requests                       | 179,916                                   |
| Achieved                       | **999.48 rps** (delivery 99.9 %)          |
| Failed                         | 0                                         |
| Latency p50 / p95 / p99        | 0.17 / 1.26 / 9.44 ms                     |
| Event-loop lag p50 / p95 / max | 20.07 / 21 / **92.08 ms** (guard: 250 ms) |
| Fullest 100 ms window          | 197 vs 100 expected (ratio 1.97)          |
| Verdict                        | PASS                                      |

The lag floor of ~20 ms is the monitor's own sampling resolution, not engine cost.

## 2. Application run at 500 rps — `run.json` + `report.html`

Created, approved and executed through the HTTP API, exactly as the UI does it.
`agent` was left unset, so the run exercised the auto-routing path.

| Metric                  | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| Engine actually used    | **vegeta** (auto-routed above 150 rps)                             |
| Requests                | 14,991                                                             |
| Achieved                | **498.54 rps**                                                     |
| Latency p50 / p95 / p99 | 0.12 / 0.43 / 1.34 ms                                              |
| Legitimate probe        | 6/6 available                                                      |
| WRS                     | 97                                                                 |
| Absorption              | 0 — the target refused nothing, as expected for a synthetic origin |
| Confidence degraded     | no                                                                 |

`report.html` is the report the application generated for this run, unmodified.

## 3. Under-delivery refusal — `refusal.json`

A campaign pinned to the built-in engine at 800 rps is refused at execution with an
actionable message instead of being graded on traffic that never arrived:

```
HTTP 400
This run asks for 800 rps / 100 concurrent on the built-in engine, whose measured
ceiling is 150 rps / 300 concurrent; it would silently under-deliver and grade the
target on traffic that never arrived. Install vegeta/k6 for the high-rate engine,
lower the rate, or set calibrate: true to measure and record the delivered amplitude.
```

At 500 rps on the built-in engine the same refusal occurs; the successful 500 rps run
above went through vegeta.

## What this establishes, and what it does not

Establishes:

- the pacer holds a steady rate for three minutes with no drift and no failure;
- the streaming latency recorder keeps event-loop lag far below the 250 ms guard;
- a high-rate run auto-routes to the external engine and the report renders from it;
- an undeliverable configuration is refused, not silently under-delivered.

Does not establish:

- performance against a **real remote target** (TLS, RTT, probe contention): the
  target here answers in microseconds on loopback;
- the behaviour of the **built-in** engine above 150 rps in production: this is a
  routing threshold plus a field observation, not a hard limit;
- anything about the fleet, `ac02`, or DRS qualification.

## Reproduce

```bash
node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(8099,'127.0.0.1')"
USER_MODE=team CAMPAIGN_CATALOG=legacy npm run dev:api     # terminal 2
npm run dev:web                                           # terminal 3
node scripts/operations/validate-pacing.mjs --rate 1000 --seconds 180 --concurrency 100
```
