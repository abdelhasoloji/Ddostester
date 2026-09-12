# Authentication & RBAC

Auth via self-contained **JWT (HS256)**, enabled **only** if `AUTH_JWT_SECRET` is
set (otherwise dev mode without auth, identity entered by hand). Designed to later
accept Keycloak tokens (same scheme).

## Roles (TSD §4.1)

| Role                           | Permissions                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `engineer` (Security Engineer) | create, execute, kill, read                                                                                                       |
| `officer` (Security Officer)   | **approve/reject** + everything the engineer can do; runtime user mgmt                                                            |
| `viewer` (SOC / NOC)           | read + emergency **kill switch**                                                                                                  |
| `ciso` (CISO)                  | read + kill + **set the operational limits** (`limits:manage`) — governance only, **not** an operator (no create/approve/execute) |

- **Separation of duties**: the approver (officer) must differ from the author;
  author and approver are **derived from the token** (cannot be spoofed via the
  request body).
- **Separation of governance**: the `officer` runs operations and manages users;
  the `ciso` alone sets the operational limits. Neither can do the other's job.
  The operational limits are always **clamped ≤ the immutable `HARD_CAPS`
  ceiling** (`config/limits.ts`), which no role can change from any interface —
  see [`safeguards.md`](./safeguards.md).

## Configuration

```bash
# 1) JWT secret (long, random)
export AUTH_JWT_SECRET="$(openssl rand -hex 32)"

# 2) hash the passwords
npm run hash-password -w backend -- MyPassword
# -> scrypt$....

# 3) declare the users (one-line JSON)
export AUTH_USERS='[
  {"email":"eng@wedos","role":"engineer","passwordHash":"scrypt$..."},
  {"email":"off@wedos","role":"officer","passwordHash":"scrypt$..."},
  {"email":"soc@wedos","role":"viewer","passwordHash":"scrypt$..."},
  {"email":"ciso@wedos","role":"ciso","passwordHash":"scrypt$..."}
]'

# 4) deploy (secrets go into /etc/ddostester.env, chmod 600)
AUTH_JWT_SECRET="$AUTH_JWT_SECRET" AUTH_USERS="$AUTH_USERS" bash deploy/setup.sh
```

`GET /health` reports `authRequired: true|false`.

## Runtime user management (officer)

`AUTH_USERS` (env) is the **immutable root**: those accounts are version-controlled
config and can never be modified or deleted through the API. On top of them, an
**officer** can manage additional users at runtime — no SSH, no redeploy — from
**Settings → Users & access** (or the API below). Runtime users are stored in the
database (scrypt-hashed passwords), and env users always take precedence.

Guards (enforced server-side, every change audited — `user.upsert`, `user.delete`,
`user.status`, `password.reset`, `password.change`):

- only an `officer` can manage users;
- env users cannot be edited, deleted, reset or deactivated here;
- you cannot modify, delete or deactivate **your own** account (no self-lockout);
- **at least one _active_ officer must always remain** (a disabled officer does
  not count);
- passwords follow one policy — **≥ 12 characters**, not a common password, and
  not built from the account's email name — hashed with scrypt (never stored in
  clear).

At login the server checks env users first (unchanged path), then store users, so
runtime users are strictly additive to the existing model.

### Lifecycle & sessions (mature user management)

- **Temporary passwords / forced change** — a password an officer sets (on
  create or reset) is temporary: the user must choose their own at first sign-in.
  Until they do, guarded routes return `403 { code: 'password_change_required' }`
  (only `/api/auth/me` and `/api/auth/password` stay reachable) and the UI shows a
  blocking change screen.
- **Self-service change** — `POST /api/auth/password` (`{ currentPassword,
newPassword }`) verifies the current password, applies the policy, rotates the
  token and **revokes the user's other sessions**. Env accounts are managed via
  configuration and cannot self-change here.
- **Admin reset** — `POST /api/users/:email/password` (`{ password }`) sets a new
  temporary password and revokes the user's sessions.
- **Soft deactivation** — `PATCH /api/users/:email { status: 'active'|'disabled' }`.
  A disabled account cannot sign in and its outstanding token is rejected at once.
- **Immediate session revocation** — each user carries a **token version**; a
  password change/reset, role change, or deactivation increments it, invalidating
  every outstanding token immediately (deletion revokes on the next request)
  rather than lingering until the 8 h token expiry.
- **Tracking** — successful logins update `lastLoginAt`; `auth.login`,
  `auth.logout` and a lockout event (`auth.login_locked`) are audited (per-attempt
  failures go to structured logs, not the tamper-evident chain).

## Endpoints

| Method | Route                                 | Required role        |
| ------ | ------------------------------------- | -------------------- |
| POST   | `/api/auth/login`                     | — (returns a token)  |
| POST   | `/api/auth/logout`                    | authenticated        |
| POST   | `/api/auth/password`                  | authenticated (self) |
| GET    | `/api/auth/me`                        | authenticated        |
| GET    | `/api/users`                          | **officer**          |
| POST   | `/api/users`                          | **officer**          |
| PATCH  | `/api/users/:email` (role / status)   | **officer**          |
| POST   | `/api/users/:email/password` (reset)  | **officer**          |
| DELETE | `/api/users/:email`                   | **officer**          |
| POST   | `/api/campaigns`                      | engineer/officer     |
| POST   | `/api/campaigns/:id/approval`         | **officer**          |
| POST   | `/api/campaigns/:id/execute`          | engineer/officer     |
| POST   | `/api/campaigns/:id/kill`             | all                  |
| GET    | `/api/campaigns`, `/api/runs`, report | all (read)           |
| GET    | `/api/limits`                         | all (read)           |
| PUT    | `/api/limits`                         | **ciso**             |

Send the token via the `Authorization: Bearer <token>` header. The report
(opened in a tab) also accepts `?token=<token>`.
