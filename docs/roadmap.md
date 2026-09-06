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

| Epic                                        | Status | Where                                                                        | Notes                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Measured WRS**                        | ✅     | `modules/protection/{provider,types}.ts`, `modules/wrs/scoring.ts`           | Push (webhook) **and** pull (metrics) connectors + a lab-only `mock`, both labelled by provenance; timeout + best-effort fallback; scoring stays a pure function. Formula weights are frozen. Remaining: wire the **real WEDOS metric names** (lab-dependent). |
| **B1 — Target telemetry in correlation**    | ⬜ 🔒  | `engine/correlation.ts`, `store/postgres.ts`                                 | Today `correlation.ts` aligns generator + probe (flow) series. Ingesting host-side conntrack/CPU/NIC needs a collector on the lab target — a new data source **and** trust boundary; design before build.                                                      |
| **B2 — Automatic baseline**                 | 🟡     | `modules/campaigns/runner.ts`, `.../acceptance.ts`, `modules/wrs/history.ts` | WRS history + baseline **regression comparison** and recurring campaigns exist. Missing: a pre-ramp **legitimate-traffic-only snapshot** with deltas surfaced on the run/report.                                                                               |
| **C — SLO gate in CI**                      | ⬜ 🔒  | `modules/campaigns/acceptance.ts`, `.github/workflows/`                      | `acceptance.ts` evaluates SLOs; no CI job yet runs a bounded campaign against a lab target. Needs a CI-only allowlist, an absolute timeout/kill, and a tolerance band so measurement noise doesn't block PRs.                                                  |
| **D — Signed proof & tamper-evident audit** | ✅     | `modules/audit/integrity.ts`, `store/{memory,postgres}.ts`, `app.ts`         | Hash-chained audit log (`prevHash`/`hash`), `GET /api/audit/verify` and `/api/audit/export`, verified end to end (memory + postgres). See [audit.md](./audit.md). Optional next: a **signature** over the export head (key management) beyond tamper-evidence. |
| **E — Drift alerting**                      | 🟡     | `modules/notify/`, `modules/wrs/history.ts`                                  | Notifications on **WRS regression** and kill already ship (Slack/webhook, opt-in). Missing: a distinct **baseline-drift** alert across recurring campaigns.                                                                                                    |

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
