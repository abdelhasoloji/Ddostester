# Provisioning runbook — the 4 WEDOS VPS

Turnkey setup for the pre-test engagement once the four VPS are live. All are
plain **Debian 13** (root). Fill the `<...>` placeholders; never commit real
secrets. Do the hosts in the order below (the app needs the DB; the lab and the
target need the app; the app's allowlist needs the target's hostname).

Topology (what the code actually supports today — the app runs the load engines
itself, so there is no separate "generator" host):

| VPS | Role                                         | Reaches                                                   |
| --- | -------------------------------------------- | --------------------------------------------------------- |
| 1   | Control plane (app + UI + load engines)      | → DB (2) on 5432 · → target (4) on 443 · ← lab runner (3) |
| 2   | PostgreSQL                                   | ← app (1) only                                            |
| 3   | Isolated class-C lab (shieldtest-lab runner) | → app (1) API only; no other egress                       |
| 4   | Target — staging CRA replica (you configure) | ← app (1)                                                 |

Generate the shared secrets once, on your workstation, and keep them in your
password manager:

```bash
BENCH_RUNNER_TOKEN=$(openssl rand -hex 24)   # app ↔ lab runner bearer
AUTH_JWT_SECRET=$(openssl rand -hex 32)       # app session signing
```

---

## VPS 2 — PostgreSQL (do first; the app needs it)

```bash
apt-get update && apt-get install -y postgresql
sudo -u postgres psql -c "CREATE USER shieldtest WITH PASSWORD '<DB_PASSWORD>';"
sudo -u postgres psql -c "CREATE DATABASE shieldtest OWNER shieldtest;"
# Listen on the private network only; allow just the app host.
#   postgresql.conf : listen_addresses = '<VPS2_PRIVATE_IP>'
#   pg_hba.conf     : host shieldtest shieldtest <VPS1_PRIVATE_IP>/32 scram-sha-256
systemctl restart postgresql
```

Firewall: allow tcp/5432 **only** from VPS 1's private IP. The schema is created
automatically by the app on first boot.

---

## VPS 1 — Control plane (app + UI + load engines)

```bash
apt-get update && apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# Optional external engines (the app falls back to the built-in HTTP engine):
#   k6:     per https://grafana.com/docs/k6/latest/set-up/install-k6/
#   vegeta: download the release binary onto $PATH
adduser --system --group shieldtest
# Deploy key so the host can fetch the repo (mirror the ac02 setup):
sudo -u shieldtest ssh-keygen -t ed25519 -f /home/shieldtest/.ssh/id_ed25519 -N ""
#   → add the printed .pub as a read-only Deploy key on abdelhasoloji/Ddostester
sudo -u shieldtest git clone git@github.com:abdelhasoloji/Ddostester.git ~shieldtest/ddostester
cd ~shieldtest/ddostester && npm ci && npm run build
```

Environment (`/etc/shieldtest.env`, read by the systemd unit):

```ini
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://shieldtest:<DB_PASSWORD>@<VPS2_PRIVATE_IP>:5432/shieldtest
AUTH_JWT_SECRET=<AUTH_JWT_SECRET>
AUTH_USERS=[{"email":"eng@wedos","role":"engineer","passwordHash":"<hash>"}, ...]
# Real targets it may load-test — add the staging replica hostname (VPS 4):
ALLOWED_TARGETS=<TARGET_FQDN>
# Class-C governance label (a lab host name, NOT a connect target):
LAB_TARGETS=<VPS3_LAB_LABEL>
# The bearer the isolated lab runner presents:
BENCH_RUNNER_TOKEN=<BENCH_RUNNER_TOKEN>
# WEDOS scrubber hook — makes detect/mitigate timing measured, not estimated:
PROTECTION_METRICS_URL=<scrubber metrics endpoint>
PROTECTION_SOURCE_LABEL=wedos-scrubbing
PROTECTION_TIMEOUT_MS=5000
```

Generate an `AUTH_USERS` password hash with the repo helper:

```bash
node -e 'import("./backend/dist/auth/passwords.js").then(m=>console.log(m.hashPassword(process.argv[1])))' '<password>'
```

Run it under systemd (the repo's `deploy/update.sh` handles build + restart on
subsequent deploys). Firewall: allow tcp/8080 from your admin tunnel and from
VPS 3 (the runner claims jobs); allow outbound to VPS 2:5432 and the target:443.
Verify: `curl -s localhost:8080/health` shows `storage:"postgres"`,
`protection:true`, and the target in `allowedTargets`.

---

## VPS 3 — Isolated class-C lab (shieldtest-lab runner)

```bash
apt-get update && apt-get install -y git ca-certificates curl
curl -fsSL https://get.docker.com | sh          # if using the Docker lab
git clone https://github.com/abdelhasoloji/shieldtest-lab.git ~/shieldtest-lab
cd ~/shieldtest-lab
# The runner claims governed class-C jobs from the control plane and posts back
# read-only verdicts. It never receives inbound connections.
BENCH_API_URL=https://<VPS1_PRIVATE_IP>:8080 \
BENCH_RUNNER_TOKEN=<BENCH_RUNNER_TOKEN> \
npm run runner
```

Firewall (fail-closed): **deny all inbound**; allow outbound **only** to VPS 1's
API port. All bench traffic stays on the host's internal/loopback network — no
spoofing, no egress. This is the isolation that keeps the offensive-shaped code
off the control plane.

---

## VPS 4 — Target (staging CRA replica) — your config

- A staging replica of the CRA platform **behind the same WEDOS protection**,
  HTTPS + **HTTP/2** enabled.
- Give VPS 1 network reach on **tcp/443**.
- Put its FQDN into VPS 1's `ALLOWED_TARGETS`, and create the campaigns with the
  authorization attestation. We never point at the real ENISA production URLs.

---

## Activation order (once all four are up)

1. DB (VPS 2) reachable from the app.
2. App (VPS 1) boots green — `/health` shows postgres + protection + the target
   allowlisted.
3. Lab runner (VPS 3) connects and appears able to claim jobs.
4. Instantiate the **`pretest-cra-l7`** playbook against the target and press
   **Run sequence** (Reports → Assessment suites). Watch the steps advance with
   real per-step verdicts; the class-C TCP line dispatches to the lab runner.

See `docs/pretest-p26-20371.md` for the line-by-line playbook mapping and the
gap register.
