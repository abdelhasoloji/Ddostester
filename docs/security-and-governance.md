# Access, authorization and operational controls

## Supported scope

ShieldTester supports bounded HTTP tests on **authorized private or public targets**. Current examples include the private Kubernetes target and the dedicated authorized public VPS. Admission requires application allowlist, approved origin/worker policy, target attestation and account capabilities. An allowlisted host does not authorize unrelated services or an arbitrary network vector.

The control plane contains capped HTTP and slow-header measurement engines plus installed-tool adapters. The synthetic UDP/TCP bench is a separate repository with registered laboratory scenarios and network guard. Its restrictions are specific to that bench; they are not a ban on normal authorized public HTTP campaigns. [Boundary](boundary-and-lab.md) explains the separation.

## Accounts and confirmation

`USER_MODE=single` is the default. `abdelha@wedos` is the sole persisted administrator and has all application capabilities. Other profiles retain their managed status and credentials. The server returns capabilities through `/api/auth/me`; routes enforce them. Single mode requires explicit owner confirmation before physical launch; team mode retains its approval/duty policy.

See [single-user lifecycle](single-user.md) for migration, profiles, password/session policy and [owner recovery](owner-recovery.md) for audited offline recovery. Never derive author/approver identity from a client-supplied label. Archived campaigns are read-only. Simulation cannot dispatch physical generators.

## Budgets and stop

`backend/src/config/limits.ts` is the source of ceilings and shape/evidence bounds. General HTTP ceilings (2,000 requests/s, concurrency 500, 900 seconds) are not the active Fleet budget. Persistent Fleet remains capped at 3 agents, shared 15 requests/s, concurrency 6 and 10–60 seconds. Only admin can manage operational limits, clamped below immutable ceilings. No automatic multiplier applies per agent.

Target health/quality gates and manual/automatic stop remain part of execution. Lost telemetry is unknown; a missing heartbeat does not prove a process stopped. Preserve final receipts, failure references, gaps and incomplete reports.

## Access and secrets

The API listens on loopback; remote access is via the deployed Caddy HTTPS/mTLS proxy or an administrative SSH tunnel. This allows authenticated remote access to a publicly addressed host without publishing the raw API. User JWT, per-agent enrollment key and transport certificate are separate identities.

Private keys, enrollment state, runtime database/auth secrets and kubeconfigs remain outside both repositories. Prefer trusted internal CA material; `INSECURE_TLS` is an explicitly labelled lab escape hatch, not a production default. Protect internal `/metrics` through network/proxy controls if exposed. Notifications are opt-in operator configuration.

## Audit and evidence

Audited mutations and evidence writes are transactional; hashing detects corruption against a trusted checkpoint. Independent witness retention remains an operator responsibility; a mutable database alone is not independent attestation. DRS imports are labelled collector-import, and a hash does not prove that physical measurements were independently acquired.

Keep authorized scope, approvals, baseline, requested/emitted/received load, functional transactions, recovery and calibration in the plan/report. Missing evidence produces partial or inconclusive results. See [DRS engine](drs-engine.md) and [current setup](current-setup.md).
