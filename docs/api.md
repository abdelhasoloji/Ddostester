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

## Infrastructure study workspace

The versioned host inventory and operator evidence endpoints under `/api/fleet/infrastructure` are described in the [workspace contract](infrastructure-workspace.md). They store metadata and attestations only; they do not grant campaign execution or hardware qualification.

### Exact Fleet device observation

`GET /api/fleet/devices/:id` requires `campaign:read`, returns the same credential-free inventory view as the device list and sets `Cache-Control: no-store`. The connection state is calculated at read time. Unknown IDs return 404. This read-only endpoint supports bounded checks of the exact campaign selection across inventory pages; it does not enroll agents, reserve capacity or dispatch a mission.
