# Security & governance

Everything that keeps this tool defensive: the safeguards enforced in code, the
authentication/RBAC model, the tamper-evident audit chain, and the security
self-review. The complementary boundary/lab story (what is _not_ implemented and
why, plus the class A/B/C policy) is in
[boundary-and-lab.md](./boundary-and-lab.md).

> **Sourcing convention.** Every claim below points to where it is enforced —
> `path` or `path:line` in this repo, or a screenshot. If a statement here and
> the code disagree, the code wins; fix the doc in the same PR.

---

## 1. Technical safeguards (enforced at every step)

| Safeguard                      | Mechanism                                                                                                                                          | Enforced in                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Allowlist**                  | Target **and** probe host must be in `ALLOWED_TARGETS`, else rejected                                                                              | `backend/src/modules/campaigns/service.ts`, `backend/src/engine/loadTest.ts`                  |
| **Attestation**                | `authorized: true` required at creation (declarative barrier)                                                                                      | `backend/src/modules/campaigns/service.ts`                                                    |
| **Hard caps (frozen ceiling)** | `maxRps ≤ 2000`, `concurrency ≤ 500`, `duration ≤ 900 s` — defined once, immutable, never editable from any interface                              | `backend/src/config/limits.ts` (`HARD_CAPS`); exposed via `/health` as `hardCapsCeiling`      |
| **Operational limits (CISO)**  | The **effective** caps enforced per campaign/playbook. Only `ciso` can change them (UI), always **clamped ≤ the ceiling** server-side, and audited | `backend/src/config/limits.ts` (`clampToCeiling`), `PUT /api/limits`; `/health` as `hardCaps` |
| **Approval workflow**          | PENDING→APPROVED/REJECTED, **separation of duties** (author≠approver **and** approver≠executor), 24 h validity, reason on reject                   | `backend/src/modules/campaigns/service.ts`, `backend/src/app.ts`                              |
| **Kill switch (3-level)**      | Auto (probe finds >30 s unavailable) / manual / time-based (`maxDurationSec`)                                                                      | `backend/src/modules/probe/probe.ts`, `backend/src/modules/campaigns/runner.ts`               |
| **Run always settles**         | A run can never hang past its cap even against a tarpit — probe wall-clock deadline + engine hard backstop (cap + 15 s), flagged `hardStopped`     | `backend/src/engine/loadTest.ts`, `backend/src/modules/probe/probe.ts`                        |
| **Request tagging**            | `X-WEDOS-TEST: <campaignId>:<ts>` header on every emitted request                                                                                  | `backend/src/modules/campaigns/runner.ts`                                                     |
| **Protocols**                  | `http` / `https` only                                                                                                                              | URL validation in `service.ts` / `loadTest.ts`                                                |

The engine also **auto-routes a high-rate simple flood** off the built-in
generator (which caps ~150 rps) to an available out-of-process engine so the
measurement isn't silently throttled — bounded and logged, never a new vector
(`backend/src/modules/campaigns/engine-route.ts`, `backend/src/config/limits.ts`
`BUILTIN_RPS_CEILING`, wired in `backend/src/app.ts` `runCampaign`).

## 2. Network / operational safeguards

- API/UI bind **loopback only** (`HOST=127.0.0.1`); remote access via SSH tunnel
  or an mTLS reverse proxy. A non-loopback bind is gated in code
  (`backend/src/util/bind.ts` `ALLOW_PUBLIC_BIND`): a private address warns, a
  public/all-interfaces bind is refused unless explicitly acknowledged.
- No public exposure; deployment via a **read-only** deploy key.
- TLS trust for internal HTTPS targets: prefer `NODE_EXTRA_CA_CERTS` (verification
  stays on). `INSECURE_TLS=true` is an **isolated-lab-only** escape hatch,
  surfaced in `/health` (`tlsInsecure`) and logged loudly at startup
  (`backend/src/util/tls.ts`).

Full deploy/hardening steps: [operations.md](./operations.md); the CISO dossier
for any networked deployment is in that file's "Public / networked deployment"
section.

---

## 3. Authentication & RBAC

Auth is self-contained **JWT HS256**, enabled **only** when `AUTH_JWT_SECRET` is
set (otherwise dev mode with a hand-entered identity). Signature is recomputed
and compared in constant time (`timingSafeEqual`); `exp` is checked; the header
`alg` never selects verification (no `alg:none` flaw). Guards live in
`backend/src/auth/guard.ts`; the role→permission matrix in
`backend/src/auth/rbac.ts` (mirrored on the frontend and locked by
`frontend/src/rbac-mirror.test.ts`).

### Roles and managed accounts

| Profile  | Capabilities                                                                             |
| -------- | ---------------------------------------------------------------------------------------- |
| admin    | All capabilities; manages accounts and operational limits. Persisted unique owner.       |
| engineer | Read, create, execute approved campaigns, kill, assistant power and target registration. |
| ciso     | Read, approve/co-sign, kill, target authorization and governed bench.                    |
| viewer   | Read only. Chat is read-oriented but subject to cost quotas.                             |

The API returns capabilities; the frontend consumes them without a separate role
matrix. The legacy officer label is normalized on migration/read. `USER_MODE=single`
is the default: the owner confirms launches explicitly. Other profiles retain
separation of duties. In team mode author/approver/executor separation remains
mandatory. `REQUIRE_CISO_APPROVAL=1` is incompatible with single mode.

Account policy v1 fixes one owner (default `abdelha@wedos`). The explicit migration
imports env accounts into PostgreSQL; startup only checks policy. The owner cannot
be demoted, disabled or deleted; another admin cannot be created. Password hashes
and statuses are preserved. Follow [single-user.md](./single-user.md), including
bootstrap and recovery, rather than treating AUTH_USERS as the normal identity source.

User changes and their audit are transactional. Password/role/status changes and
session revocation advance tokenVersion. HTTP password work uses bounded async
scrypt; login has global/source budgets before hashing, plus per-email/source
lockout. Stored passwords are never returned. Password resets require a subsequent
password change; self-service rotation returns a fresh session.

### Browser reads and session transport

Writes require Bearer authentication. Reports and SSE use a `shieldtest_read`
HttpOnly, SameSite=Strict cookie, refreshed by login, password rotation, session
revocation and `/api/auth/me`. It is Secure except for loopback HTTP development.
Cookie reads revalidate account status and tokenVersion; SSE rechecks during its
lifetime. Session JWTs in query parameters are refused. Existing short-lived
share tokens remain read-only in team mode; single mode refuses sharing.

Node is bound to loopback by default; use HTTPS/mTLS or SSH tunnels for access.
A token in localStorage is still sensitive to same-origin script execution; CSP
and controlled asset delivery remain mandatory. Cookie authentication is not
accepted for writes. API details: [api.md](./api.md).

### Session decision — roadmap R02

The selected transport is a **one-hour Bearer write session**, with a separate
HttpOnly read cookie for SSE/reports. Login, password rotation and self-session
revocation issue new JWTs with `exp - iat = 3600` seconds. There is no silent
refresh token or rolling extension: password authentication is required again
at expiry. `/api/auth/me` refreshes only the read cookie's remaining lifetime,
not the signed JWT. The frontend removes its cached token on HTTP 401.

This keeps the existing API authorization contract while bounding the default
browser write credential. A full write-cookie session would require a separate
CSRF design and browser/API migration; it is not implemented by repurposing the
read cookie. localStorage persistence is retained, so the token remains readable
by same-origin JavaScript; the shorter lifetime does not remove that exposure.

Existing signed sessions retain their own expiry during migration, including
older eight-hour sessions. No account password, status or tokenVersion is reset
by this change; explicit revocation remains available. Read-only share tokens
retain their separately specified TTL and cannot authorize writes. This policy is
active in the private Linux source-06 lab, with login/JWT/cookie lifetime
verified through its real API. Production build 451 is unchanged; full browser
expiry/reconnection recipes remain separate validations.

## 4. Tamper-evident audit chain

Every governed action (create, approve, reject, execute, kill, user/playbook
changes, limits, bench) is linked into a **SHA-256 hash chain**, so changes to retained chain entries are detectable. It generates no traffic and changes no boundary. Logic
is a pure module, `backend/src/modules/audit/integrity.ts`, covered by
property-based tests.

- `prevHash` = previous entry's `hash` (or `GENESIS`); `hash =
SHA-256(prevHash + "\n" + canonical(entry))` over immutable fields
  `[id, at, actor, action, campaignId, detail]`.
- Appends are serialized (Postgres advisory lock; single-threaded in memory) so
  the chain never forks.
- `verifyChain` reports **content**, **link** and **missing-hash** breaks. The
  first _retained_ entry's `prevHash` is an accepted anchor, so retention pruning
  is not tampering; truncation of the newest entries is caught only against a
  previously exported `headHash` (why the export includes it).

| Method | Path                | Role          | Returns                                          |
| ------ | ------------------- | ------------- | ------------------------------------------------ |
| GET    | `/api/audit/verify` | campaign:read | `{ ok, count, headHash, brokenAt? }`             |
| GET    | `/api/audit/export` | campaign:read | Downloadable JSON: entries + hashes + `headHash` |

UI: **Audit log → Verify integrity** (verdict badge) and **Export (JSON)**.
Retention (`pruneOldData`) deletes entries older than `RETENTION_DAYS`; the tail
stays verifiable via the anchor rule.

---

Every business write also commits an actor-bound `store.mutate` receipt in the same
transaction, with a SHA-256 of its arguments (never their secret values). Summary
entries no longer silently swallow failures. Launch and GPU-power intent is
persisted before external effects. User lifecycle operations use their explicit
transactional audit entries.

External anchoring is an operational dependency: `scripts/audit-checkpoint.mjs`
exports a witness with exclusive creation and checks continuity against a previous
witness. Retain witnesses in a separate access-controlled/immutable destination.
The application database alone cannot prove that an administrator did not rewrite
its entire history. No external witness service is provisioned automatically.

## 5. Security self-review

### Threat model

| Threat                        | Handling                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- |
| Using the tool against others | Mandatory allowlist + attestation; out of scope = 400/403                   |
| Public exposure of the API    | Loopback bind by default; TLS/mTLS reverse proxy for any remote access      |
| Privilege escalation          | RBAC on every route (`auth/rbac.ts`, `auth/guard.ts`); separation of duties |
| Author/approver spoofing      | Derived from the JWT, never the request body                                |
| Credential theft              | scrypt passwords; anti-brute-force lock (5 → 60 s)                          |
| Token leak in logs            | `?token=` redaction; Authorization header not logged                        |
| SQL injection                 | 100 % parameterized queries (`pg`)                                          |
| Uncontrolled load             | Hard caps + 3-level kill switch                                             |

Verified points (all integration-tested): permission guards on every `/api`
route (401 without a token, 403 by role); separation of duties at approval;
allowlist for target + probe; read-token query param verified through the same
permission logic.

### Residual risks (accepted / operator-handled)

- **Authorization attestation is declarative** — a barrier, not proof; scope
  responsibility stays with the operator (`SECURITY.md`).
- **`/metrics` has no auth** (non-sensitive aggregates, internal network);
  protect via the reverse proxy if exposed.
- **CORS** default `origin: false` (same-origin); opt-in via `CORS_ORIGIN`. With
  Bearer auth (no cookies) there is no CSRF surface.
- **mTLS** is provided at the reverse proxy (Caddy), not in the app.
- **`INSECURE_TLS`** disables TLS verification process-wide (lab only; loud
  startup warning). Prefer `NODE_EXTRA_CA_CERTS`.

### Secret rotation

Runtime secrets live in `/etc/ddostester.env` (chmod 600), never in the repo or
the systemd unit. Rotate on VPS 1:

```bash
bash deploy/rotate-secrets.sh          # DB_PASSWORD + AUTH_JWT_SECRET
bash deploy/rotate-secrets.sh --bench  # also BENCH_RUNNER_TOKEN
```

Health-gated with automatic rollback; never prints a secret; keeps a timestamped
`.bak`. `BENCH_RUNNER_TOKEN` (shared with the lab runner) and the Grafana admin
password (VPS 2, `grafana-cli admin reset-admin-password`) are manual companion
steps the script prints. Never paste a secret into a chat, ticket or transcript.

---

## 6. Where the boundary is stated (map)

| Intent (policy)           | File                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| Acceptable/prohibited     | `SECURITY.md`, `CONTRIBUTING.md`                                          |
| Non-negotiable for agents | `CLAUDE.md`                                                               |
| Scope + "not implemented" | this file §1–2, [boundary-and-lab.md](./boundary-and-lab.md), `README.md` |
| Status source of truth    | [roadmap.md](./roadmap.md)                                                |
| Class A/B/C policy        | [boundary-and-lab.md](./boundary-and-lab.md)                              |

Enforcement (control plane): `campaigns/model.ts` (`HARD_CAPS` + attestation
shape), `campaigns/service.ts` (allowlist/caps/approval/duty), `engine/loadTest.ts`
(off-allowlist rejection + rate cap), `auth/rbac.ts` + `auth/guard.ts` (roles),
`probe/probe.ts` (kill switch), `runner.ts` (timeout + `X-WEDOS-TEST`),
`agents/types.ts` (`AttackAgent` contract).
