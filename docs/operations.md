# Operations runbook

Non-functional operations for running WEDOS ShieldTest in production.

## Health & readiness

| Endpoint  | Meaning                                          | Use for        |
| --------- | ------------------------------------------------ | -------------- |
| `/health` | process is up; returns config summary            | liveness       |
| `/ready`  | store is reachable (DB `SELECT 1`); `503` if not | readiness / LB |

Point your load balancer / uptime monitor at `/ready` so a database outage marks
the instance as not-serving instead of silently failing requests.

## Security headers

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and a strict `Content-Security-Policy`
(`default-src 'self'`; no external origins). CORS is same-origin by default; set
`CORS_ORIGIN` only if the UI is hosted elsewhere.

## Data retention

Runs, audit entries and WRS samples older than `RETENTION_DAYS` (default 90; `0`
disables) are pruned once a day, plus once at startup. Campaigns are kept.

## Internal HTTPS targets (TLS trust)

Testing an internal target over HTTPS (e.g. behind the WAF with a private CA):

- **Preferred — trust the internal CA:** `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
  TLS verification stays **on**; works for the built-in engine and the probe (and
  every external engine that reads the system/Node trust store).
- **Isolated lab escape hatch:** `INSECURE_TLS=true` disables TLS certificate
  verification for **all** outbound requests of the process (target, probe, and
  notification/protection webhooks). It is surfaced in `/health`
  (`"tlsInsecure": true`), logged loudly at startup (`[tls] …`), and shown on the
  Settings page. Never enable it outside a closed lab.

## Configuration is validated at boot

Invalid numeric env vars (`PORT`, `SCHEDULER_INTERVAL_MS`, `RETENTION_DAYS`, …)
or an empty `ALLOWED_TARGETS` make the service **fail fast** at startup rather
than run with silent defaults. Check `journalctl -u ddostester` on a boot loop.

## Backup & restore (PostgreSQL)

Only the database holds durable state; secrets live in `/etc/ddostester.env`.

```bash
# Backup (cron this, e.g. daily, and copy off-host)
pg_dump "$DATABASE_URL" -Fc -f "shieldtest-$(date +%F).dump"

# Restore into an empty database
pg_restore --clean --if-exists -d "$DATABASE_URL" shieldtest-YYYY-MM-DD.dump

# Also back up the secrets file (separately, restricted access)
sudo cp /etc/ddostester.env /secure/backup/ddostester.env.$(date +%F)
```

The schema is applied by **ordered migrations** at startup (tracked in
`schema_migrations`, each run once in a transaction), so a restore into a fresh
database followed by a service start brings it fully up to date. The baseline
migration adopts an existing database cleanly.

## Deploy & automatic rollback

`deploy/update.sh` (run by CD) records the current commit, deploys the new one
(`npm ci` → build → test → restart), then checks `/ready` with retries. **If the
new version is unhealthy it rolls back to the previous commit automatically** and
exits non-zero. Manual rollback:

```bash
git -C ~/ddostester reset --hard <good-sha> && bash ~/ddostester/deploy/update.sh
```

## Notes / known limits

- Single process: live progress and kill switches are in-memory, so the control
  plane does not run active/active. A restart during a run ends that run.
- List endpoints (`/api/campaigns`, `/api/runs`) are unpaginated — fine at the
  current scale; add pagination before very large histories.
