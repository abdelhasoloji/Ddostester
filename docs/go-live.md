# Go-live checklist (Docker Compose)

Step-by-step runbook for putting the WEDOS ShieldTest control plane into
production with **Docker Compose**. It assumes the tool stays what it is: an
**internal, loopback-only** control plane reached over an SSH tunnel (or behind
the internal reverse proxy), never exposed to the public Internet.

Work top to bottom. Each box is a hard gate — do not proceed past a failing one.

## 0. Assumptions & scope

- [ ] Target host: Linux with Docker Engine + the Compose plugin
      (`docker compose version` works).
- [ ] The API is reached via **SSH tunnel** or the **internal proxy** — no public
      exposure. The compose file publishes the API on `127.0.0.1:8080` only.
- [ ] You have the list of **authorized test targets** (the allowlist) approved
      for this deployment.

## 1. Secrets & configuration

Keep a `.env` file next to `docker-compose.yml` (Compose reads it automatically).
It is **not** committed — `.dockerignore` and `.gitignore` exclude it.

- [ ] `POSTGRES_PASSWORD` — set to a strong, unique value (**required**; Compose
      refuses to start without it).
- [ ] `ALLOWED_TARGETS` — the exact allowlist (comma-separated hosts/IPs). List
      **only** internal/mandated targets. Do not use a wildcard.
- [ ] `GRAFANA_PASSWORD` — required **only if** you enable the `monitoring`
      profile (Compose refuses to start Grafana without it).
- [ ] Optional auth: set **both** `AUTH_JWT_SECRET` (long random string) and
      `AUTH_USERS` to require signed tokens + RBAC. Leave empty to rely on the
      loopback bind + SSH tunnel alone.
- [ ] `SHIELDTEST_DOMAIN` — set if you enable the `proxy` (TLS) profile.

Example `.env` (fill in real values):

```dotenv
POSTGRES_PASSWORD=change-me-strong
ALLOWED_TARGETS=127.0.0.1,test-host.internal
# GRAFANA_PASSWORD=change-me            # only with --profile monitoring
# AUTH_JWT_SECRET=...                   # optional: enables auth + RBAC
# AUTH_USERS=[{"email":"off@wedos","role":"officer","passwordHash":"scrypt$..."}]
#   hash a password: npm run hash-password -w backend -- <password>  (see docs/auth.md)
# SHIELDTEST_DOMAIN=shieldtest.internal # only with --profile proxy
```

## 2. Get the code at the intended revision

- [ ] `git fetch origin main && git checkout main && git pull --ff-only`
- [ ] Note the SHA you are deploying: `git rev-parse HEAD` (kept for rollback).

## 3. Build & start

- [ ] `docker compose up -d --build`
      (add `--profile monitoring` and/or `--profile proxy` if used).
- [ ] `docker compose ps` — `db` and `api` are `healthy` / `running`.

## 4. Bind verification (must be loopback only)

- [ ] `ss -tlnp | grep -E ':8080|:5432'` shows **only** `127.0.0.1` — never
      `0.0.0.0` or a routable IP. (Inside the container the API binds `0.0.0.0`;
      the published mapping restricts it to loopback — verify at the host.)
- [ ] If anything is on a public IP, **stop immediately**
      (`docker compose down`) and fix the port mapping before retrying.

## 5. Smoke tests

- [ ] `curl -s localhost:8080/health` → `{"status":"ok",...,"storage":"postgres"}`
      (confirm `storage` is `postgres`, not `memory`).
- [ ] `curl -s localhost:8080/ready` → ready.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/` → `200` (the UI
      is served — the api image ships the built frontend).
- [ ] `curl -s localhost:8080/health | grep -o '"allowedTargets":\[[^]]*\]'` —
      the allowlist matches what you configured (no stray entries).
- [ ] If auth is enabled: `curl -s localhost:8080/health` shows
      `"authRequired":true`, and an unauthenticated write is rejected.
- [ ] Run **one bounded campaign** against an allowlisted target through the UI
      or API and confirm it completes and produces a WRS. Confirm a campaign
      against a **non-allowlisted** target is rejected (400/403).
- [ ] Confirm the **kill switch** works: start a campaign, then
      `POST /api/campaigns/:id/kill`, and verify it stops.

## 6. TLS / mTLS (if exposed beyond loopback)

Only needed if you front the API with the bundled proxy rather than an SSH
tunnel or the existing internal proxy.

- [ ] `docker compose --profile proxy up -d --build`.
- [ ] `curl -k https://$SHIELDTEST_DOMAIN/health` succeeds through the proxy.
- [ ] For mTLS: uncomment the `client_auth` block in `deploy/proxy/Caddyfile`,
      mount the CA, and confirm a request **without** a client cert is refused.

## 7. Monitoring (optional)

- [ ] `docker compose --profile monitoring up -d`.
- [ ] Grafana reachable via SSH tunnel to `127.0.0.1:3000`; log in with
      `GRAFANA_PASSWORD` (not the default — there is no default anymore).
- [ ] The **WEDOS ShieldTest** dashboard shows data after a campaign.

## 8. Rollback plan (know it before you need it)

- [ ] Automated: `DEPLOY_MODE=docker DEPLOY_BRANCH=main bash deploy/update.sh`
      fetches, rebuilds, health-checks `/ready`, and **auto-rolls-back to the
      previous commit** if the new revision is unhealthy.
- [ ] Manual: `git reset --hard <good-sha> && docker compose up -d --build`.
- [ ] Data: `pgdata` is a named volume and survives `docker compose up`. A
      destructive rollback of the schema is out of scope here — take a
      `pg_dump` before risky migrations.

## 9. Post-go-live

- [ ] Watch logs for the first runs: `docker compose logs -f api`.
- [ ] Confirm `restart: unless-stopped` brings the stack back after a host
      reboot (`sudo reboot`, then re-check §4–§5).
- [ ] Record the deployed SHA, the allowlist, and who approved the go-live in
      your change log.

## Sign-off

| Item                          | Owner | Verified |
| ----------------------------- | ----- | -------- |
| Secrets set, no weak defaults |       |          |
| Loopback-only bind confirmed  |       |          |
| Allowlist correct             |       |          |
| Smoke tests + kill switch     |       |          |
| Rollback rehearsed            |       |          |

---

See also: `docs/deployment.md` (systemd model and details), `docs/ci-cd.md`
(automated deploy + `DEPLOY_MODE`), `docs/operations.md`, `docs/safeguards.md`
and `docs/security-review.md`.
