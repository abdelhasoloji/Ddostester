# CLAUDE.md — WEDOS ShieldTest (control plane)

Guide for agents/contributors working on this repository.

## What this project is

Internal **resilience testing** control plane: orchestration, governance,
measurement and scoring of load campaigns against **authorized** infrastructure.
Full-stack: Fastify/TypeScript backend (ESM, Node ≥ 22.19), React/Vite frontend.

## Non-negotiable boundary (must be respected absolutely)

The **control plane** (`backend/` + `frontend/` — the deployed product)
**implements no amplification, spoofing, or unbounded-exhaustion attack vector**:
no L3/L4 flood, no amplification (DNS/NTP/SSDP/CLDAP), no Smurf, and no
malformed/oversized-payload L7 exhaustion (RUDY, WebSocket flood, XML bomb,
browser botnet). Every vector it _does_ implement is **bounded, governed,
single-source, and aimed at an allowlisted target**:

1. a **bounded HTTP generator** (`engine/loadTest.ts`) — GET/POST, rate-capped; and
2. a **bounded slow-header connection probe** (`engine/slowloris.ts`, vector
   `http-slowloris`) that opens ≤ `concurrency` connections and holds them with an
   incomplete-but-well-formed request to **measure whether the target sheds slow
   requests** (a request/header timeout — good) or lets them accumulate (bad).
   Real source, **no spoofing**, only well-formed HTTP, capped on connection count
   (≤ `HARD_CAPS.maxConcurrency`) and lifetime (≤ `HARD_CAPS.maxDurationSec`), and
   kill-switchable like every other run. It is a resilience **measurement**, not a
   volumetric flood or an exploit.

External load generation goes through **adapters** (`backend/src/agents/`) that
delegate to licensed tools (k6, Vegeta, Locust) operated by the team — never
offensive code here. Any contribution adding an **amplification, source-spoofing,
or unbounded/volumetric** vector to the control plane is out of scope.

A **closed synthetic network lab** that models UDP-amplification traffic shape
for defensive measurement (no source-IP spoofing, no real reflector protocol,
hard caps, isolated `internal` network) lives in a **separate repository** —
[`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab) —
so the boundary is **structural, not conventional**: this control plane contains
**no attack vector at all**. The two connect only through a read-only, governed
verdict contract (see `docs/boundary-and-lab.md`). See `docs/security-and-governance.md`
and `docs/boundary-and-lab.md`.

## Install / run / test

Prerequisites: **Node ≥ 22.19**, **PostgreSQL** (falls back to in-memory store if
unset), Docker only for the optional Compose stack / mTLS proxy.

```bash
# Install (npm workspaces: backend + frontend)
npm install
cp .env.example .env             # then fill in DB URL, JWT secret, ALLOWLIST, etc.

# Run (dev)
npm run dev:api                  # Fastify API in watch mode (tsx)
npm run dev:web                  # React/Vite UI
# or the full Compose stack (API + Postgres + UI):
docker compose up -d             # add --profile proxy for the TLS/mTLS reverse proxy

# Test / verify
npm run typecheck                # backend + frontend (tsc)
npm test                         # backend (Vitest) + frontend
npm run test:e2e                 # Playwright (builds first)
npm run lint                     # ESLint + Prettier check
npm run verify                   # lint + typecheck + test + build (run before every PR)
npm run build                    # build backend + frontend
```

Deployment: `bash deploy/setup.sh` (systemd, loopback). See `docs/operations.md`.

### Certificates (mTLS) — `~/shieldtest-pki`

The mTLS PKI (CA, server cert/key, per-role client bundles `client-*.crt/.key/.p12`)
lives **outside every repo**, in `~/shieldtest-pki`, and is **never committed**.
`.gitignore` blanket-ignores `shieldtest-pki/`, `*.key` and `*.p12`; the deploy
proxy mounts these files read-only. Regenerate with
`deploy/proxy/make-ca-certs.sh`. Never copy private key material into the repo,
`.env`, logs, or issues.

## Relationship to `shieldtest-lab`

The isolated mitigation bench [`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab)
runs entirely on its own. Its **telemetry / verdict artifacts feed the WRS**
(WEDOS Resilience Score) here **read-only**, through the governed contract in
`docs/boundary-and-lab.md` (UDP amplification = class C, standalone
evidence; the control plane records class A/B only). This control plane **never**
emits amplification traffic.

## Architecture (summary)

- `backend/src/app.ts` — `buildApp()`: routes + logic (injectable for tests).
- `backend/src/server.ts` — entry point: store, auth, scheduler, listen, graceful shutdown.
- `backend/src/engine/loadTest.ts` — bounded HTTP generator (phases, RPS cap, kill switch). **Invariant: a run always settles at cap + grace** — the probe has a wall-clock deadline and the engine races the workers against a hard backstop, so a tarpitting target (undici pool exhaustion) can never hang a run (`LoadTestResult.hardStopped` flags it).
- `backend/src/agents/` — `AttackAgent` contract + builtin/k6/vegeta/locust adapters.
- `backend/src/modules/` — campaigns (CAM + scheduler), probe (+ kill switch), wrs (scoring + history), reports (campaign + compliance), metrics, audit.
- **Observability**: `GET /metrics` (Prometheus — business + runtime: HTTP/route, runs in-flight/duration, `loadtest_hard_stopped_total`, event-loop lag, process) and structured `run.start`/`run.settled` pino logs. See `docs/observability.md`.
- `backend/src/store/` — PostgreSQL persistence (+ best-effort TimescaleDB) or memory.
- `backend/src/auth/` — JWT HS256 + RBAC (engineer/ciso/admin/viewer).
- `frontend/src/` — React dashboard (login, campaigns, WRS, audit, live SSE progress).

Full docs: `docs/` (index in `docs/README.md`).

## Status / roadmap

`docs/roadmap.md` is the **source of truth** for what is built vs. planned.
Update it in the same PR that changes behaviour, and reconcile any external
brief or plan against it rather than trusting the brief's own status.

## Golden rule — no out-of-allowlist load generation

**Never generate load — from any tool, script, or adapter — against a target
that is not on the lab's allowlist.** The control plane's bounded HTTP generator
enforces `ALLOWLIST` + `HARD_CAPS` at runtime; do not bypass, widen, or hard-code
around them. All amplification-shaped traffic belongs to `shieldtest-lab`, whose
`lib/net-guard.mjs` refuses any destination outside its RFC1918 `/24` and whose
Compose network is `internal: true`. Do not point a generator at a real host,
run bench components outside the isolated lab network, or launch load against
production/public infrastructure under any circumstance.

## Conventions

- TypeScript strict, ESM (imports end in `.js`). Comments in English.
- Safeguards first: allowlist, `HARD_CAPS`, attestation, approval, kill switch,
  audit — never bypass or weaken them.
- All safety caps and run-shape bounds live in ONE file, `backend/src/config/limits.ts`
  (the single source of truth): `HARD_CAPS`, `MIN_RECURRENCE_MIN`, `MAX_ENDPOINTS`,
  `MAX_USER_AGENTS`, `MAX_FLOW_STEPS`, `MAX_THINK_MS`, `MAX_DATASET_ROWS`,
  `MAX_PLAYBOOK_STEPS`, `MAX_PLAYBOOK_HEADERS`. Other modules re-export from it.
  Define a new limit here — never a second copy.
- Two-layer caps: `HARD_CAPS` is the **immutable, frozen ceiling** (never editable
  from any interface). The **operational limits** are the effective caps enforced
  on campaigns/playbooks; only the **`admin`** role can change them (`limits:manage`,
  `PUT /api/limits`), always clamped ≤ the ceiling (`clampToCeiling`) and audited
  (`limits.update`). Enforcement reads the effective caps threaded from `app.ts`;
  the frontend reads them from `/health` (`hardCaps` = effective, `hardCapsCeiling`
  = ceiling). Never widen the ceiling to satisfy a request.
- Every change: `npm run typecheck && npm test && npm run build` must pass.
- Secrets are never committed; tokens are never logged (request serializer).

## Unique administrator with managed profiles

The administrator has all application capabilities. USER_MODE=single selects the default
personal workflow: the owner explicitly confirms every launch; team mode retains separation
of duties. The persisted owner defaults to abdelha@wedos; other profiles remain manageable
and retain their status/password. A second admin and owner demotion/deletion are forbidden.
Run the versioned migration explicitly before the first new-version startup; ordinary startup
only verifies policy. Capabilities are returned by /api/auth/me and enforced by the API.
Allowlist, immutable caps, kill switch and audit remain mandatory. No campaign is required
for account/deployment validation. See [migration and operation](docs/single-user.md).
