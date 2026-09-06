# WRS — WEDOS Resiliency Score

Resilience score 0–100 computed **from measured metrics**. The function is pure
(`backend/src/modules/wrs/scoring.ts`): it generates no traffic.

## Formula

```
WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C
```

| Comp. | Name              | Computation                                   | Bounded |
| ----- | ----------------- | --------------------------------------------- | ------- |
| D     | Detection         | `100 − detection_s / 2`                       | [0,100] |
| M     | Mitigation        | `100 − mitigation_s / 3`                      | [0,100] |
| A     | Availability      | `legitimate_success / legitimate_total × 100` | [0,100] |
| C     | Collateral damage | `100 − adjacent_service_impact`               | [0,100] |

Example (TSD §5.4): detection 10 s → D = 95; mitigation 30 s → M = 90;
99.5 % availability → A = 99.5; no impact → C = 100 → **WRS ≈ 95.85 (A+)**.

## Levels

| WRS    | Level | Interpretation         |
| ------ | ----- | ---------------------- |
| 95–100 | A+    | exceptional resilience |
| 85–94  | A     | excellent              |
| 70–84  | B     | acceptable             |
| 50–69  | C     | identified weaknesses  |
| 30–49  | D     | insufficient           |
| 0–29   | F     | not resilient          |

## Origin of the inputs

- **A** and **C** come directly from the **probe** (availability measured on the
  target and neighbouring endpoints).
- **D** and **M**: with no protection integration, the runner derives
  conservative estimates from the kill-switch state (the score is then flagged
  `estimated`).

## Protection integration (measured D & M)

Make the WRS reflect **real** timings instead of estimates via one of two
pluggable connectors (both talk the same JSON shape; the webhook wins when both
are set):

- **Push** — set `PROTECTION_WEBHOOK_URL`. At the end of each run the control
  plane POSTs the run window to that endpoint:

  ```json
  { "campaignId": "…", "target": "https://…", "startedAt": "…", "finishedAt": "…" }
  ```

- **Pull** — set `PROTECTION_METRICS_URL`. The control plane GETs that endpoint
  with the run window as query params (`campaignId`, `target`, `from`, `to`),
  for a protection stack that exposes metrics rather than calling back.

Either way the source answers with the measured timings:

```json
{ "detectionTimeSec": 4, "mitigationTimeSec": 11, "source": "cloudflare" }
```

`source` labels the provenance; if the connector omits it, `PROTECTION_SOURCE_LABEL`
is stamped instead so the origin is always explicit (and a lab `mock` is always
tagged `mock`). When a valid response comes back, Detection and Mitigation use
those values and the score is no longer `estimated`; on any error, timeout, or
invalid payload it silently falls back to the estimate. This is **inbound
measurement only** — it generates no traffic. `GET /health` reports
`protection: true|false`, and **Settings → Engine & security** shows _Measured
WRS_ vs _Estimated WRS_.
