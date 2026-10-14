# Operations — deploy, run, CI/CD & hardening

Everything to stand up, update and run the control plane. It stays what it is: an
**internal, loopback-only** control plane reached over an SSH tunnel or an mTLS
reverse proxy, never exposed to the public Internet. Observability (metrics,
dashboards, alerts) is in [observability.md](./observability.md); security in
[security-and-governance.md](./security-and-governance.md).

---

## 1. Install & run

Prerequisites: Ubuntu/Debian, **Node ≥ 22**, systemd; PostgreSQL to persist
(memory fallback otherwise); Docker only for the optional Compose stack.

**Get the code** with a read-only deploy key (GitHub → repo → Settings → Deploy
keys), then:

```bash
bash deploy/setup.sh            # idempotent: pull + install + build + test + systemd unit + health check
```

Overridable env: `PORT` (8080), `HOST` (`127.0.0.1` — **never** `0.0.0.0`),
`ALLOWED_TARGETS` (allowlist). Add a target:
`ALLOWED_TARGETS="127.0.0.1,test-host.internal" bash deploy/setup.sh`.

**Persistence.** Default single mode requires PostgreSQL, strong JWT auth and the explicit account migration in [single-user.md](./single-user.md). In-memory storage is restricted to legacy team-mode development/tests.
To persist: `DATABASE_URL="postgresql://shieldtest:pw@127.0.0.1:5432/shieldtest"
bash deploy/setup.sh`. The schema is applied by **ordered migrations** at startup
(`schema_migrations`, each once in a transaction) so a restore into a fresh DB +
start is fully up to date. TimescaleDB is auto-detected (`wrs_samples` becomes a
hypertable). `curl -s localhost:8080/health` → `"storage":"postgres"`.

**Reach the UI** from your workstation (not the server):
`ssh -L 8080:127.0.0.1:8080 <user>@<server>` → `http://localhost:8080`.

**systemd**: `systemctl status ddostester`; `journalctl -u ddostester -n 50
--no-pager`; unit at `/etc/systemd/system/ddostester.service`.

**Docker Compose** (API image builds + serves the UI):
`POSTGRES_PASSWORD=… ALLOWED_TARGETS=… docker compose up -d --build`
(`--profile proxy` for TLS/mTLS, `--profile monitoring` for Prometheus/Grafana).

**Bind check (do this every deploy):** `ss -tlnp | grep 8080` must show **only**
`127.0.0.1:8080`. A public IP → stop the service and redeploy with
`HOST=127.0.0.1`. A non-loopback bind is code-gated (`backend/src/util/bind.ts`,
`ALLOW_PUBLIC_BIND`): private address warns, public bind refused unless
acknowledged.

---

## 2. CI/CD

| Workflow | File                             | Trigger                             | Purpose                                                                               |
| -------- | -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| CI       | `.github/workflows/ci.yml`       | push to `main`, every PR            | 3 parallel jobs: quality (lint+typecheck+audit), frontend, backend (each tests+build) |
| E2E      | `.github/workflows/e2e.yml`      | **nightly** + manual                | Playwright browser smoke **and** the backend catalog end-to-end runs (`CATALOG_E2E`)  |
| Deploy   | `.github/workflows/deploy.yml`   | after CI succeeds on `main`; manual | update the service on VPS 1                                                           |
| SLO gate | `.github/workflows/slo-gate.yml` | manual dispatch (lab target)        | one bounded campaign → SLO pass/fail                                                  |

Push/PR CI runs unit coverage only (the slow catalog E2E moved to the nightly E2E
workflow), so it is ~1 min. Deploy runs **only** when CI is green on `main`, so a
red build never reaches the server; it can also be launched manually
(**Run workflow**), optionally choosing a branch (that is the rollback path).

**Deploy model — self-hosted runner on VPS 1.** The runner polls GitHub outbound
(HTTPS 443): no inbound SSH, no deploy secrets in GitHub, the app stays
loopback-only. The Deploy job requires the **`vps1`** label
(`runs-on: [self-hosted, vps1]`). One-time setup as root on VPS 1:
`RUNNER_TOKEN=<reg token> bash deploy/provision/host-runner.sh` (installs the
runner as the `shieldtest` user, grants the single sudo rule `systemctl restart
ddostester`), then remove the old `ac02` runner.

**`deploy/update.sh`** (what CD runs) fetches the branch, deploys, health-checks
`/ready`, and **auto-rolls-back to the previous commit** if unhealthy.
`DEPLOY_MODE=systemd` (default: `npm ci`→build→test→restart) or `docker`
(`docker compose up -d --build`). It **never** touches the systemd unit or
`/etc/ddostester.env`, so automated deploys can't erase configuration
(`deploy/setup.sh` writes those, by hand, once).

**Rollback**: Actions → Deploy → Run workflow (pick a ref), or on the server
`git -C ~/ddostester reset --hard <good-sha> && bash deploy/update.sh`.

---

## 3. Reference topology (2 VPS + external test target)

The engagement target is an authorized **external** host (e.g. `bank.cz`), so
there is no target VPS; Postgres runs **on the app host**. This uses 2 of 4
ordered VPS (the rest are spare). Bootstrap scripts turn the manual steps into
one idempotent command per host.

| Host      | Role                                                     | Reaches                             |
| --------- | -------------------------------------------------------- | ----------------------------------- |
| **VPS 1** | Control plane — app + UI + load engines + local Postgres | → target:443 · ← lab runner (VPS 2) |
| **VPS 2** | Isolated class-C lab (`shieldtest-lab` runner)           | → VPS 1 API only; no other egress   |

**VPS 1** — `deploy/provision/host-app.sh` (then `deploy/setup.sh`). Env in
`/etc/ddostester.env` (chmod 600): `DATABASE_URL`, `AUTH_JWT_SECRET`,
`USER_MODE` and persisted managed profiles (engineer/ciso for team, owner confirmation for single), `ALLOWED_TARGETS`,
`LAB_TARGETS` (a class-C governance label, **not** a connect target),
`BENCH_RUNNER_TOKEN`, and the scrubber hook (`PROTECTION_METRICS_URL`,
`PROTECTION_SOURCE_LABEL`). Hash passwords with `npm run hash-password -w backend
-- <pw>`. Verify `/health` shows postgres + protection + the target allowlisted.

**VPS 2** — `BENCH_API_URL=http://<VPS1_PRIVATE_IP>:8080 BENCH_RUNNER_TOKEN=<same>
bash deploy/provision/host-lab.sh`. Firewall fail-closed: **deny all inbound**;
allow outbound **only** to VPS 1's API port. To let VPS 2 reach the loopback API:
either bind a **private IP** (`HOST=<VPS1_PRIVATE_IP>`, firewall tcp/8080 to
VPS 2 only) or a **WireGuard/SSH tunnel** (keep loopback). Verify: `/health`
`labTargets` non-empty; `systemctl status shieldtest-lab-runner`; a bench
**Request run** moves `REQUESTED → CLAIMED → COMPLETED` (stuck at `REQUESTED` =
the runner can't reach the API — check bind/firewall/token).

**Gotchas learned in bring-up:** the WEDOS VPN filters the VPS `/24` (SSH times
out — disconnect the VPN; `443` refused while `22` times out is the tell);
minimal Debian has no `sudo` (`host-app.sh` installs it); `adduser --system` home
`/nonexistent` breaks the clone (pin `/home/shieldtest`); git "dubious ownership"
when building as root breaks pulls **and** the version stamp — the deploy scripts
self-heal it (`git config --global --add safe.directory …`; use `git reset
--hard`, not `git pull`).

---

## 4. Go-live checklist (hard gates — do not proceed past a failure)

1. **Secrets** — `POSTGRES_PASSWORD` strong; `GRAFANA_PASSWORD` if monitoring;
   both `AUTH_JWT_SECRET` **and** `AUTH_USERS` to require auth. `.env` next to
   `docker-compose.yml`, never committed.
2. **Code at the intended SHA** — note `git rev-parse HEAD` for rollback.
3. **Build & start** — `docker compose up -d --build`; `docker compose ps` all
   healthy.
4. **Bind** — `ss -tlnp | grep -E ':8080|:5432'` shows only `127.0.0.1`.
5. **Smoke** — `/health` `storage:postgres`; `/ready` ready; `/` → 200 (UI
   served); allowlist matches; a bounded campaign completes with a WRS; a
   non-allowlisted target is rejected (400/403); the **kill switch** stops a run.
6. **TLS/mTLS** if exposed beyond loopback (§5). 7. **Monitoring** optional
   (observability.md). 8. **Rollback rehearsed** (auto via `deploy/update.sh`, or
   `git reset --hard <sha> && docker compose up -d --build`; `pg_dump` before
   risky migrations). 9. Record the SHA, allowlist and go-live approver.

---

## 5. Public / networked deployment (CISO dossier)

The engagement traffic is already bounded/allowlisted/authorized; the risk of a
networked VPS is a third party taking over the **plane itself**. Required before
any deployment beyond loopback, CISO-signed:

- **mTLS edge** — the API is never exposed directly; a reverse proxy
  (Caddy/nginx/Traefik) terminates TLS, requires a **client certificate** issued
  by our internal CA, forwards to loopback `127.0.0.1:8080`, and rate-limits.
  Ready-to-use config in `deploy/proxy/` (mTLS `Caddyfile`, PKI generator
  `make-ca-certs.sh`, README). The lab runner reaches the API over a **private
  tunnel**, not the public interface.
- **Dual control** — `REQUIRE_CISO_APPROVAL=1`: every campaign needs author
  (engineer) → officer approval (≠ author) → **CISO sign-off** (≠ author, ≠
  officer), enforced in `runCampaign` so neither the execute endpoint nor the
  suite sequencer can bypass it; audited `campaign.ciso_approve`; `/health`
  advertises `requireCisoApproval`. Endpoint `POST /api/campaigns/:id/ciso-approval`.
- **Prerequisites** — rotate every ever-shared secret and re-issue password
  hashes; TLS+mTLS in front; ≥ 1 officer **and** 1 ciso; firewall so only the
  proxy (+ lab tunnel) reaches the app port; scheduled off-host audit export;
  `ALLOWED_TARGETS` minimal, `LAB_TARGETS` disjoint.

Already in place (baseline governance): RBAC + separation of duties, immutable
HARD_CAPS + CISO operational limits, per-campaign attested authorization,
allowlist, kill switch + auto-kill, tamper-evident audit chain, login lockout,
security headers, the bind guard.

---

## 6. Operations runbook (non-functional)

| Endpoint  | Meaning                                    | Use for        |
| --------- | ------------------------------------------ | -------------- |
| `/health` | process up; config summary                 | liveness       |
| `/ready`  | store reachable (`SELECT 1`); `503` if not | readiness / LB |

- **Security headers** on every response: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a strict CSP
  (`default-src 'self'`). CORS same-origin unless `CORS_ORIGIN` is set.
- **Retention** — runs, audit entries and WRS samples older than `RETENTION_DAYS`
  (default 90; `0` disables) are pruned daily + at startup. Campaigns are kept.
- **Config validated at boot** — invalid numeric env or empty `ALLOWED_TARGETS`
  makes the service **fail fast** (check `journalctl` on a boot loop).
- **Backup/restore (Postgres holds all durable state)**:
  `pg_dump "$DATABASE_URL" -Fc -f dump` / `pg_restore --clean --if-exists -d
"$DATABASE_URL" dump`; back up `/etc/ddostester.env` separately.
- **Incident runbook** — `/health` down → `journalctl`, fix, restart; API on a
  public IP → redeploy `HOST=127.0.0.1`; campaign rejected 403/400 → off-allowlist
  / not approved / cap exceeded; campaign stuck RUNNING → `POST
/api/campaigns/:id/kill` then check logs.
- **Known limits** — single process: live progress + kill switches are in-memory,
  so no active/active; a restart during a run ends that run (reconciled to
  APPROVED at startup). List endpoints are unpaginated (fine at current scale).

- **Template matrix sweep** — `scripts/template-matrix.mjs` runs one
  representative line of every curated template against one or more targets and
  prints a comparison matrix (WRS / availability / mechanism / origin-5xx). It
  recons each target and uses each template's `requires` (h2 / waf / cache /
  dynamic) to mark a line **N/A** where the target lacks the feature, instead of a
  misleading pass. Runs on the control-plane host (needs `AUTH_JWT_SECRET`) via
  the governed flow, bounded by `HARD_CAPS`:
  `set -a; . /etc/ddostester.env; set +a; node scripts/template-matrix.mjs --dur 30 http://<bare-origin>/ https://<protected>/`

## Verified release promotion and hardening

### Local PostgreSQL and recovery verification

With dependencies installed and the PostgreSQL 16 image already cached in a local Docker context:

```sh
task_pg_evidence_parent="$(mktemp -d)"
node scripts/operations/local-postgres-gate.mjs "$task_pg_evidence_parent/new-gate"
```

The gate accepts no application database URL. It creates a dedicated temporary PostgreSQL container and bridge network, publishes only on loopback, runs all mandatory PostgreSQL suites and the encrypted recovery check, then verifies removal of its identified resources. The container uses the cached image ID, a non-root user, 0.5 CPU, 512 MiB RAM and temporary data storage. Credentials are private and removed after cleanup; logs and cleanup receipts remain in the new private evidence directory. No image download occurs during the gate. Its Node version is recorded, so a local run on Node 26 does not establish CI parity with Node 22.

Append `--browser-single` to run the single-owner browser recipe against that same disposable database after the PostgreSQL and recovery suites. Build the app first (`npm run build`) and provide an installed Playwright browser, optionally through `PW_CHROMIUM`. The dedicated configuration verifies the loopback gate database name and tests persistence of operational limits and explicit execution confirmation. This recipe does not yet cover the complete account/session matrix. Its fixture remains separate from the default team/memory browser suite.

`deploy/update.sh` now refuses local changes and builds a new immutable directory
from the fetched revision. It runs the full verification before switching the
systemd service via `40-verified-release.conf`; existing envfiles remain untouched.
It verifies API build identity, readiness and every UI asset against a release
manifest. Failure restores the previous override. The previous `30-access-release`
override is retained, so rollback to it remains possible. Do not delete releases
or backups until retention and rollback have been reviewed.

This automatic path supports systemd. Docker requires explicitly versioned image
promotion and manifest validation; the script refuses the old unchecked Compose
promotion. Additional sudo rights are needed for installing the override and
reloading systemd; a restart-only CI rule is insufficient. Setup preserves an
existing envfile, checks the persisted account policy before restart, and migrates
accounts only when `MIGRATE_ACCOUNTS=1` is explicitly selected. Bootstrap secrets
must be removed after successful provisioning.

Only one runtime per PostgreSQL database is supported; an advisory lease rejects
another replica. Shutdown blocks new launches and kills active runs. All starts
revalidate current destinations, authorization, approvals and operational limits.
`RETENTION_DAYS=0` disables retention. `INSECURE_TLS=true` also requires the explicit
`ISOLATED_LAB=1` opt-in and is forbidden on connected deployments; use a trusted CA.

Browser reads use the HttpOnly cookie described in security-and-governance.md;
never put session JWTs in report URLs. Assistant chat budgets are two concurrent
streams, five per identity/minute, twenty globally/minute; upstream buffers are
bounded and downstream backpressure is respected. Login cost budgets are twenty
per source/minute and one hundred globally/minute, independently of email.

Prometheus names now describe generator observations: `successful_rps` and
`failed_ratio`. Historical JSON absorption fields remain compatible but do not
prove origin traffic or edge absorption. Target/edge telemetry is needed for
attribution. Dashboards and alert rules must be promoted with the app.

Audit witnesses: run `scripts/audit-checkpoint.mjs` from an independently controlled
collector with a read token supplied through its environment. Store each witness
under a new filename outside the application host, pass the previous witness to
check continuity, and alert on failure. Credentials, sink and scheduling belong
to the infrastructure configuration; none is created or invoked by this change.

Owner password recovery uses the audited, offline administrative procedure in
[owner-recovery.md](./owner-recovery.md). It requires the exclusive PostgreSQL
runtime lease and preserves the existing sole administrator and other accounts.

For private laboratory builds from preserved local work, see the identified
[source snapshot procedure](./source-snapshots.md). Product releases still require
the reviewed Git reference and release gate.
