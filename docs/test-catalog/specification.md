# Specification reference for the functional test catalog

This is a test/reference artifact, not today’s deployment or physical DRS qualification. Use [current verification](../testing.md) and workspace configuration for current gates. Historical result counts do not replace a fresh run.

Every expected result in the catalog is argued against a numbered rule here. Rules
are drawn from the code and the project's stated safeguards (`SECURITY.md`,
`docs/security-and-governance.md`, `docs/security-and-governance.md`, `backend/src/auth/rbac.ts`,
`backend/src/modules/campaigns/model.ts`). Where the observed behaviour diverges
from a rule — or from the _principle_ a rule rests on — the case is tagged a
**FINDING** in the results, not silently accepted.

## Roles & permissions (RBAC)

- **SPEC-RBAC-1** — Three roles exist: `engineer`, `officer`, `viewer`
  (`rbac.ts`). Permissions per role are fixed by the matrix:
  - officer: read, create, approve, execute, kill, user:manage
  - engineer: read, create, execute, kill (**not** approve)
  - viewer: read, kill (**not** create/approve/execute)
- **SPEC-RBAC-2** — Every `/api/*` route is guarded by a single permission. A
  role **with** the permission reaches the handler (2xx/4xx business result); a
  role **without** it gets **403**; a request with **no token** (auth enabled)
  gets **401**.
- **SPEC-RBAC-3** — When auth is disabled (no `AUTH_JWT_SECRET`), there is no
  login and every action is open (no 401/403).
- **SPEC-RBAC-4** — The emergency kill switch is available to **all** roles,
  viewer included (`campaign:kill` in every row).

## Separation of duties (SoD)

- **SPEC-SOD-1** — The approver must differ from the author of a campaign
  (`SECURITY.md`; enforced server-side and in the UI).
- **SPEC-SOD-2** — SoD is extended to execution: the officer who **approved** a
  campaign may **not** also execute it (`403`). Author≠approver is enforced at
  approval; approver≠executor is enforced at execution. A different actor (e.g.
  the engineer author) may execute an officer-approved campaign.

## Authorization attestation

- **SPEC-ATT-1** — A campaign must be attested `authorized: true` by its author;
  anything else is rejected (`createCampaign`).

## Allowlist (anti-SSRF / scope control)

- **SPEC-ALLOW-1** — Target, probe, every flow step and every weighted endpoint
  must resolve to a host in `ALLOWED_TARGETS`; otherwise the campaign is rejected
  (`assertHostAllowed`).
- **SPEC-ALLOW-2** — Only `http`/`https` URLs are accepted; other schemes are
  rejected.
- **SPEC-ALLOW-3** — The host match is exact (hostname equality), so a
  sub-domain of an allowed host, or the allowed host embedded elsewhere, is
  **not** allowed.
- **SPEC-ALLOW-4** — Redirects are never followed by the engine
  (`redirect: 'manual'`), so an allowed host cannot bounce traffic off-allowlist.

## Hard caps (bounded load, defense in depth)

- **SPEC-CAP-1** — `HARD_CAPS = { maxRps: 2000, concurrency: 500,
maxDurationSec: 900 }`. Each cap is a whole number: a value that is
  non-integer, `< 1`, non-finite, or above its cap is rejected; the boundary
  value (exactly the cap) is accepted (`service.ts`).

## Campaign lifecycle / state machine

- **SPEC-LIFE-1** — A new campaign is `PENDING_APPROVAL`.
- **SPEC-LIFE-2** — Only an `APPROVED` campaign can be executed; executing a
  pending/rejected one is rejected.
- **SPEC-LIFE-3** — Approving/executing/killing a non-existent id is `404`.
- **SPEC-LIFE-4** — A run ends `COMPLETED`, `KILLED_AUTO` (probe unavailable
  ≥ 30 s) or `KILLED_MANUAL`; a kill carries a human `statusDetail`.

## Users (governance)

- **SPEC-USER-1** — Only `officer` (`user:manage`) may list/create/patch/delete
  runtime users. `POST` is **create-only**: re-creating an existing user is a
  `409` (no silent overwrite); role changes go through `PATCH`.
- **SPEC-USER-2** — Env-defined (`AUTH_USERS`) users are the immutable root and
  cannot be deleted via the API (`docs/security-and-governance.md`).
- **SPEC-USER-3** — Passwords are validated (min length) and stored scrypt-hashed,
  never in clear.

## Audit (tamper-evidence)

- **SPEC-AUDIT-1** — Every privileged action appends an audit entry; the trail is
  a hash chain that `/api/audit/verify` reports as intact or broken-at-n.

## Campaign shapes & engines

- **SPEC-SHAPE-1** — A campaign supports these shapes, each accepted at creation
  and executable: vector `http-get`/`http-post`, multi-phase `scenario`,
  multi-step `flow` (with optional `{{var}}`/`extract` correlation), weighted
  `endpoints` mix, `userAgents` rotation, `dataset` feeder, response `assertion`,
  `acceptance` SLO, `recurrence`, and `scheduledAt`.
- **SPEC-SHAPE-2** — Endpoint mix, UA rotation, data feeder and assertions
  require the built-in engine; multi-phase and correlation require an engine that
  advertises the capability. Incompatible engine + feature is rejected (400).
- **SPEC-SHAPE-3** — Engines: `builtin`, `k6`, `vegeta`, `locust`, `jmeter`,
  `gatling`. An unknown engine id is rejected (400). A known but **not-installed**
  engine falls back to the built-in engine at execution (the UI's "→ default"),
  so the run still completes.

## Observability

- **SPEC-OBS-1** — `/health`, `/ready`, `/metrics` are open (no auth) for probes;
  `/health` reports storage, auth, agent, allowlist.
