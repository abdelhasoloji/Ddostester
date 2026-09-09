# Provisioning runbook — lean setup (2 VPS + bank.cz)

The engagement target is **`bank.cz`** (an authorized external test target), so
there is no target VPS. Keeping it simple: Postgres runs **on the app host**, not
a separate DB server. That uses **2 of the 4 ordered VPS**; the other two are
spare/standby.

| Host      | Role                                                       | Reaches                                |
| --------- | ---------------------------------------------------------- | -------------------------------------- |
| **VPS 1** | Control plane — app + UI + load engines + Postgres (local) | → `bank.cz`:443 · ← lab runner (VPS 2) |
| **VPS 2** | Isolated class-C lab (shieldtest-lab runner)               | → VPS 1 API only; no other egress      |
| target    | `bank.cz` (external, allowlisted + authorized)             | —                                      |

**Bootstrap scripts** turn the manual steps below into one command per host —
`deploy/provision/host-app.sh` (VPS 1) and `deploy/provision/host-lab.sh`
(VPS 2). They are idempotent, take secrets via env (never invent them), and the
app one hands off to the existing `deploy/setup.sh`. The manual steps that
follow are the reference the scripts automate.

Both VPS are plain **Debian 13** (root). Generate the two shared secrets once on
your workstation and keep them in your password manager:

```bash
BENCH_RUNNER_TOKEN=$(openssl rand -hex 24)   # app ↔ lab runner bearer
AUTH_JWT_SECRET=$(openssl rand -hex 32)       # app session signing
```

---

## VPS 1 — Control plane (app + UI + engines + Postgres)

```bash
apt-get update && apt-get install -y git curl postgresql
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# Local Postgres (loopback only — no network exposure needed):
sudo -u postgres psql -c "CREATE USER shieldtest WITH PASSWORD '<DB_PASSWORD>';"
sudo -u postgres psql -c "CREATE DATABASE shieldtest OWNER shieldtest;"
# Optional external engines (the app falls back to the built-in HTTP engine):
#   k6: grafana.com/docs/k6/latest/set-up/install-k6 · vegeta: release binary on $PATH
adduser --system --group shieldtest
sudo -u shieldtest ssh-keygen -t ed25519 -f /home/shieldtest/.ssh/id_ed25519 -N ""
#   → add the printed .pub as a read-only Deploy key on abdelhasoloji/Ddostester
sudo -u shieldtest git clone git@github.com:abdelhasoloji/Ddostester.git ~shieldtest/ddostester
cd ~shieldtest/ddostester && npm ci && npm run build
```

Environment (`/etc/shieldtest.env`, read by the systemd unit):

```ini
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://shieldtest:<DB_PASSWORD>@127.0.0.1:5432/shieldtest
AUTH_JWT_SECRET=<AUTH_JWT_SECRET>
AUTH_USERS=[{"email":"eng@wedos","role":"engineer","passwordHash":"<hash>"}, ...]
ALLOWED_TARGETS=bank.cz
LAB_TARGETS=<VPS2_LAB_LABEL>          # class-C governance label, NOT a connect target
BENCH_RUNNER_TOKEN=<BENCH_RUNNER_TOKEN>
# WEDOS scrubber hook — makes detect/mitigate timing measured, not estimated:
PROTECTION_METRICS_URL=<scrubber metrics endpoint>
PROTECTION_SOURCE_LABEL=wedos-scrubbing
PROTECTION_TIMEOUT_MS=5000
```

Password hash for `AUTH_USERS`:

```bash
node -e 'import("./backend/dist/auth/passwords.js").then(m=>console.log(m.hashPassword(process.argv[1])))' '<password>'
```

Run under systemd (`deploy/update.sh` handles build + restart on later deploys).
Firewall: tcp/8080 from your admin tunnel + VPS 2 (the runner claims jobs);
outbound to `bank.cz`:443. Verify `curl -s localhost:8080/health` shows
`storage:"postgres"`, `protection:true`, and `bank.cz` in `allowedTargets`.

---

## VPS 2 — Isolated class-C lab (shieldtest-lab runner)

```bash
apt-get update && apt-get install -y git ca-certificates curl
curl -fsSL https://get.docker.com | sh          # if using the Docker lab
git clone https://github.com/abdelhasoloji/shieldtest-lab.git ~/shieldtest-lab
cd ~/shieldtest-lab
BENCH_API_URL=https://<VPS1_PRIVATE_IP>:8080 \
BENCH_RUNNER_TOKEN=<BENCH_RUNNER_TOKEN> \
npm run runner
```

Firewall (fail-closed): **deny all inbound**; allow outbound **only** to VPS 1's
API port. All bench traffic stays on the host's internal/loopback network — no
spoofing, no egress. This isolation keeps the offensive-shaped code off the
control plane.

---

## Activation order

1. VPS 1 boots green — `/health` shows postgres + protection + `bank.cz`
   allowlisted.
2. VPS 2 runner connects and can claim jobs.
3. Instantiate **`pretest-cra-l7`** against `https://bank.cz/` and press **Run
   sequence** (Reports → Assessment suites). Steps advance with real per-step
   verdicts; the class-C TCP line dispatches to the lab runner.
4. To iterate on the WEDOS rules, follow the **tune-and-replay** loop
   (`docs/tune-and-replay.md`): change one rule, replay the playbook, and read
   the per-line WRS delta via **"Compare vs previous ↗"**.

Note: `pretest-cra-l7`'s login step targets `/realms/srp/account` (the CRA
path). Against `bank.cz`, set the target path or expect a 404 on that step —
adjust the step's `paths` if bank.cz uses a different login route (the recon
in the **Preparation** phase finds the real one). See
`docs/pretest-p26-20371.md` for the line-by-line mapping and the gap register.

## Operational gotchas (learned in bring-up)

- **WEDOS VPN filters the VPS subnet.** SSH and the KVM console to the VPS time
  out while the WEDOS VPN is connected (it filters `31.31.74.0/24`). Disconnect
  the VPN for admin access. A `443` connection is refused (host reachable) while
  `22` times out — that mixed signal is the tell.
- **Minimal Debian image has no `sudo`.** `host-app.sh` now installs it; if you
  bootstrap by hand, `apt-get install -y sudo` first.
- **`adduser --system` gives `/nonexistent` as home**, which the service clone
  cannot write to. `host-app.sh` now pins `/home/shieldtest`; an older run is
  repaired in place (its `.ssh` deploy key is moved, not regenerated).
- **The API listens on loopback only.** Reach the UI from your workstation with
  an SSH tunnel _run on the workstation_ (not on the VPS):
  `ssh -L 8080:127.0.0.1:8080 root@<VPS1_IP>`, then open `http://localhost:8080`.
- **Auth needs at least two users** (author ≠ approver). Generate hashes with
  `node -e 'import("./backend/dist/auth/passwords.js").then(m=>console.log(m.hashPassword(process.argv[1])))' '<pw>'`
  and set `AUTH_USERS` (an `engineer` + an `officer`) in `/etc/ddostester.env`.
