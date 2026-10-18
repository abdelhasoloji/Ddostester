# API contracts

The deployed API is loopback `http://127.0.0.1:8080`, reached remotely through authenticated TLS/mTLS or a protected tunnel. User requests use the account/session capability contract; agent and bench credentials are separate. JSON is standard; report routes also provide HTML/CSV where implemented.

## Primary surfaces

| Surface                                               | Contract authority                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/health`, `/ready`                                   | Runtime/build identity and readiness; `backend/src/app.ts`                                             |
| `/api/auth/me`, account/session routes                | Server capabilities, sole admin, mode/approval policy; `backend/src/auth/` and `routes/user-routes.ts` |
| Campaign create/approve/execute/kill/archive          | `modules/campaigns/`, `app.ts`; archived read-only and explicit single-mode confirmation               |
| `/api/drs/validations`, `/api/drs/reference`          | Standalone no-traffic fixture campaign and pinned reference; `routes/drs-routes.ts`                    |
| `/api/campaigns/:id/drs/*`                            | Revision/freeze/capacity/simulation/evidence/attachment/finalize/report; [DRS details](drs-engine.md)  |
| `/api/fleet/devices`, `/api/fleet/sites`              | Paginated inventory, identity/site uniqueness; `routes/fleet-routes.ts`                                |
| Fleet enrollment and heartbeat                        | `routes/fleet-enrollment-routes.ts`; per-agent secrets, sequence and expiration                        |
| `/api/fleet/overview`, `/api/fleet/missions`          | Persistent mission/progress/stop; `routes/fleet-mission-routes.ts`                                     |
| Fleet status/durable evidence, reports, metrics/audit | `routes/read-routes.ts`; incomplete data remains unknown                                               |
| `/api/targets`                                        | Explicit target/origin management; `routes/target-routes.ts`                                           |
| `/api/bench/runs/*`                                   | Registered laboratory dispatch/artifact contract; [cross-repository details](cross-repo-contract.md)   |
| Assistant proposals/status                            | `routes/assistant-routes.ts`; capability-governed actions                                              |

The DRS-only catalogue is the default. Legacy model/suite creation is not an alternative to disabled catalogue adapters. Do not use older example bodies with a client-selected author/approver or class-A/B record as the current DRS plan contract.

DRS mutations except draft revision creation require `revisionId`; stale requests fail. Physical running/archived campaigns refuse conflicting evidence mutations. Imports use validated evidence envelopes and transactional audit/archive writes. `report.json`/`report.html` support explicit revision reads.

See [user journey](usage.md), [Fleet contract](fleet-missions.md), [security](security-and-governance.md) and the source-derived [route inventory](api-routes.md). The inventory lists literal route declarations, not a promise that every legacy route is available under today's policy. Dynamically expanded DRS routes are documented above.

### Nonblocking campaign start

`POST /api/campaigns/:id/execute` accepts `background: true` alongside the existing explicit `confirmed: true` in single-owner mode. It returns HTTP 202 with `{campaignId, statusUrl}` and a Location header only after execution guards pass, a kill switch is registered and RUNNING is persisted. Poll the authenticated campaign URL / reconnect to its progress stream; use the retained `runId` to retrieve a completed run. A duplicate active start is refused. The normal confirmation, approval, policy and concurrency bounds apply; this is immediate execution, not a queue. The original blocking 201 response remains available when background is omitted. Never automatically retry a start after an uncertain network result; read campaign state first.

A failed baseline retains `baselineDiagnostic` on the DRS revision and JSON/HTML report, including bounded sample distribution, elapsed/observed duration, availability, mean, coefficient of variation, frozen tolerance and reason (unhealthy, unstable, incomplete, cancelled or deadline). This is diagnostic data, not qualified DRS evidence. The campaign detail remains readable after reconnect. Blocking clients receive HTTP 422 `baseline_rejected` with the diagnostic/reference instead of a generic internal error. Missing diagnostics on older revisions stay absent.

## Pre-step review (classic HTTP suites)

- `POST /api/suites/:id/run`: optional boolean `pauseBetweenSteps` (UI sends true). The current step finishes normally; later runnable steps wait for resume. The existing pause, resume and cancel routes remain available.
- `GET /api/campaigns/:id/parameters`: campaign-read permission; returns the unstarted campaign, revision digest, effective limits and built-in routing hints. Hints do not certify hardware throughput.
- `POST /api/campaigns/:id/parameters`: campaign-create permission; accepts revision, maxRps, concurrency, maxDurationSec and, for an existing scenario, its phase rates/durations. No target/engine/stop fields. Preserves phase count; validates existing campaign rules and current caps. Saved state is PENDING_APPROVAL with prior signatures cleared and an atomic before/after audit. Conflicting revisions or active work return 409.
- `POST /api/suites/:id/resume`: modified steps require approval in team mode. In single-owner mode the body requires `confirmed: true` and `reviewedSteps` matching the budgets produced by the shared `parameterBudget` contract (id, maxRps, concurrency, maxDurationSec, scenario or null). A mismatched review returns 409; no unreviewed budget is approved. The following step is reloaded before dispatch.

Completed/historical campaigns and frozen DRS/Fleet documents use their existing immutable history/revision workflows rather than in-place parameter editing.
