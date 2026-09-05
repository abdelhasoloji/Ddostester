# Deployment & operations

Target: Ubuntu 24.04 server, Node 22, systemd. The API/UI listens on **loopback
only**; remote access is via an **SSH tunnel** (no public exposure — the tool has
no application-level authentication).

## Prerequisites

- Node 22:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- SSH access to the server; a user with `sudo`.
- Read access to the repository (deploy key recommended).

## Get the code (deploy key)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ddostester_deploy -N "" -C "ddostester-deploy"
cat ~/.ssh/ddostester_deploy.pub    # → GitHub: repo → Settings → Deploy keys (read-only)

cat >> ~/.ssh/config <<'CFG'
Host github-ddostester
  HostName github.com
  User git
  IdentityFile ~/.ssh/ddostester_deploy
  IdentitiesOnly yes
CFG

git clone github-ddostester:abdelhasoloji/Ddostester.git ~/ddostester
```

## Deploy / update

The `deploy/setup.sh` script is **idempotent**: pull + install + build + tests

- (re)writes the systemd service + checks the loopback bind + health check.

```bash
cd ~/ddostester
bash deploy/setup.sh
```

Overridable variables:

| Variable          | Default               | Purpose                                   |
| ----------------- | --------------------- | ----------------------------------------- |
| `PORT`            | `8080`                | Listen port (loopback)                    |
| `HOST`            | `127.0.0.1`           | Listen address — **do not set `0.0.0.0`** |
| `ALLOWED_TARGETS` | `127.0.0.1,localhost` | Allowlist of targets/probes               |

Add an authorized target:

```bash
ALLOWED_TARGETS="127.0.0.1,test-host.internal" bash deploy/setup.sh
```

## Persistence (PostgreSQL)

By default, without `DATABASE_URL`, the API stores campaigns and runs **in
memory** (lost on restart — handy in dev/tests). To persist, provide a
PostgreSQL database:

```bash
# option A — managed/installed Postgres, then:
DATABASE_URL="postgresql://shieldtest:password@127.0.0.1:5432/shieldtest" \
  bash deploy/setup.sh

# option B — full stack via Docker (API + Postgres):
POSTGRES_PASSWORD=... ALLOWED_TARGETS="127.0.0.1,test.host" docker compose up -d --build
```

The schema (`campaigns`, `runs`) is created automatically at startup
(idempotent). Runs keep `wrs`/`wrs_level` and the target, the basis of a
per-target WRS history. Check the active backend:

```bash
curl -s localhost:8080/health   # {"storage":"postgres", ...}
```

## Accessing the interface (SSH tunnel)

From the **local machine** (not the server):

```bash
ssh -L 8080:127.0.0.1:8080 <user>@<server>
# as long as the session stays open:
#   http://localhost:8080  → the server's UI + API
```

## systemd service

```bash
systemctl status ddostester
journalctl -u ddostester -n 50 --no-pager   # logs
sudo systemctl restart ddostester
```

Generated unit: `/etc/systemd/system/ddostester.service`
(`WorkingDirectory=<repo>/backend`, `ExecStart=/usr/bin/node dist/server.js`,
`Restart=on-failure`).

## Security checks

```bash
# 1) the API must listen ONLY on loopback
ss -tlnp | grep 8080          # expected: 127.0.0.1:8080 only

# 2) effective allowed targets
curl -s localhost:8080/health # {"status":"ok","allowedTargets":[...]}
```

If `ss` shows a public IP (`0.0.0.0` or a routable IP), **stop the service** and
redeploy with `HOST=127.0.0.1`.

## Incident runbook

| Symptom                     | Diagnosis                  | Action                                                  |
| --------------------------- | -------------------------- | ------------------------------------------------------- |
| `/health` does not respond  | `journalctl -u ddostester` | fix the error, `systemctl restart`                      |
| API on a public IP          | `ss -tlnp \| grep 8080`    | redeploy with `HOST=127.0.0.1`                          |
| Campaign rejected (403/400) | API error message          | target outside allowlist, not approved, or cap exceeded |
| Campaign stuck in RUNNING   | probe/kill switch          | `POST /api/campaigns/:id/kill` then check logs          |

## TLS / mTLS (reverse proxy)

The TSD calls for “HTTPS + mTLS”. A Caddy reverse proxy is provided (Docker profile):

```bash
SHIELDTEST_DOMAIN=shieldtest.internal POSTGRES_PASSWORD=... \
  docker compose --profile proxy up -d --build
```

- Terminates TLS in front of the API (self-signed internal certificate by
  default; for real certificates, adjust `deploy/proxy/Caddyfile`).
- **mTLS**: uncomment the `client_auth` block in the Caddyfile + mount the
  internal CA (`deploy/proxy/ca.crt`) to require a WEDOS client certificate.

Docker-free alternative: place the loopback API behind the existing internal
reverse proxy (Caddy/nginx) that handles TLS and, if needed, mutual auth.

## Database: PostgreSQL or TimescaleDB

Default is `postgres:16`. To enable TimescaleDB (WRS time series as a
hypertable):

```bash
DB_IMAGE=timescale/timescaledb:latest-pg16 POSTGRES_PASSWORD=... \
  docker compose up -d --build
```

The application detects the extension at startup: if present, `wrs_samples`
becomes a hypertable; otherwise it stays a standard PostgreSQL table (identical
behaviour). No application configuration change is required.
