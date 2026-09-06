# Roadmap & implementation status

Single source of truth for **what is built vs. planned**. Keep it in sync with
the code in the same PR that changes behaviour — an external brief or plan should
be reconciled against this file, not the other way round.

> Scope is fixed: this control plane implements **no attack vector** and never
> weakens a safeguard (allowlist, HARD_CAPS, attestation, approval workflow,
> 3-level kill switch, `X-WEDOS-TEST` tagging, audit). Every item below is
> delivered **through** those safeguards. See [safeguards.md](./safeguards.md).

Legend: ✅ done · 🟡 partial · ⬜ planned · 🔒 needs external infra (lab / cluster)

## Horizon 1 — reliability of the measurement

| Epic                                        | Status | Where                                                                               | Notes                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — Measured WRS**                        | ✅     | `modules/protection/{provider,types}.ts`, `modules/wrs/scoring.ts`                  | Push (webhook) **and** pull (metrics) connectors + a lab-only `mock`, both labelled by provenance; timeout + best-effort fallback; scoring stays a pure function. Formula weights are frozen. Remaining: wire the **real WEDOS metric names** (lab-dependent).                                                                       |
| **B1 — Target telemetry in correlation**    | 🟡 🔒  | `modules/target-telemetry/`, `.../campaigns/runner.ts`, `modules/reports/report.ts` | **Pull** connector (no inbound surface): during a run the control plane GETs a lab metrics endpoint once a second (CPU/conntrack/NIC), correlated to the run timeline and summarised on the report; unit-tested with a mock. Remaining: wire the real lab metrics endpoint (field names/units) and optional time-series persistence. |
| **B2 — Automatic baseline**                 | ✅     | `modules/campaigns/baseline.ts`, `.../runner.ts`, `modules/reports/report.ts`       | Each run captures a pre-ramp **legitimate-traffic-only** snapshot (nominal availability + latency) and reports the **under-load deltas** on the run detail and HTML report. WRS history + cross-run regression comparison already shipped (P0-2).                                                                                    |
| **C — SLO gate in CI**                      | 🟡 🔒  | `modules/campaigns/slogate.ts`, `cli/slogate.ts`, `.github/workflows/slo-gate.yml`  | Gate logic (SLO thresholds + WRS-regression tolerance band) is built and unit-tested; the CLI + workflow run a bounded campaign through the allowlist/caps/approval path with an absolute timeout. **Manual-dispatch only** until a lab target is reachable from CI (uncomment the schedule then).                                   |
| **D — Signed proof & tamper-evident audit** | ✅     | `modules/audit/integrity.ts`, `store/{memory,postgres}.ts`, `app.ts`                | Hash-chained audit log (`prevHash`/`hash`), `GET /api/audit/verify` and `/api/audit/export`, verified end to end (memory + postgres). See [audit.md](./audit.md). Optional next: a **signature** over the export head (key management) beyond tamper-evidence.                                                                       |
| **E — Drift alerting**                      | ✅     | `modules/notify/events.ts`, `.../campaigns/baseline.ts`                             | WRS-regression and kill alerts (Slack/webhook, opt-in) plus a distinct **`baseline.drift`** alert when a target's nominal baseline degrades between recurring runs (availability −≥5 pts, or p95 +≥25% and ≥20 ms).                                                                                                                  |

## Horizon 2 & 3 — scale (only once the measurement is stable)

| Epic                                                                  | Status | Guard-rail reminder                                                  |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| F — Distributed agent fleet                                           | ⬜     | Caps enforced **centrally** by the control plane                     |
| G — mTLS control plane ↔ agents                                       | ⬜     | No unauthorised agent                                                |
| H — Durable job queue + resumable runs                                | ⬜     | Kill switch and audit preserved                                      |
| I — Realistic bounded traffic (flows, think-time, endpoint weighting) | 🟡     | Flows / endpoint mix / UA rotation already bounded + tagged          |
| J — Playbook builder UI                                               | 🟡     | Custom playbooks exist; each step still goes through approval + caps |
| K — Multi-tenant / SSO / Vault / HA                                   | ⬜     | RBAC and separation of duties reinforced                             |

## Sequencing

A → B → C, with D and E in parallel; Horizons 2/3 only after the measurement is
trustworthy. Do not scale a fragile measurement.
