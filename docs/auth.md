# Authentication & RBAC

Auth via self-contained **JWT (HS256)**, enabled **only** if `AUTH_JWT_SECRET` is
set (otherwise dev mode without auth, identity entered by hand). Designed to later
accept Keycloak tokens (same scheme).

## Roles (TSD §4.1)

| Role                           | Permissions                                         |
| ------------------------------ | --------------------------------------------------- |
| `engineer` (Security Engineer) | create, execute, kill, read                         |
| `officer` (Security Officer)   | **approve/reject** + everything the engineer can do |
| `viewer` (SOC / NOC)           | read + emergency **kill switch**                    |

- **Separation of duties**: the approver (officer) must differ from the author;
  author and approver are **derived from the token** (cannot be spoofed via the
  request body).

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
  {"email":"soc@wedos","role":"viewer","passwordHash":"scrypt$..."}
]'

# 4) deploy (secrets go into /etc/ddostester.env, chmod 600)
AUTH_JWT_SECRET="$AUTH_JWT_SECRET" AUTH_USERS="$AUTH_USERS" bash deploy/setup.sh
```

`GET /health` reports `authRequired: true|false`.

## Endpoints

| Method | Route                                 | Required role       |
| ------ | ------------------------------------- | ------------------- |
| POST   | `/api/auth/login`                     | — (returns a token) |
| GET    | `/api/auth/me`                        | authenticated       |
| POST   | `/api/campaigns`                      | engineer/officer    |
| POST   | `/api/campaigns/:id/approval`         | **officer**         |
| POST   | `/api/campaigns/:id/execute`          | engineer/officer    |
| POST   | `/api/campaigns/:id/kill`             | all                 |
| GET    | `/api/campaigns`, `/api/runs`, report | all (read)          |

Send the token via the `Authorization: Bearer <token>` header. The report
(opened in a tab) also accepts `?token=<token>`.
