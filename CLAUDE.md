# CLAUDE.md — WEDOS ShieldTest (control plane)

Guide for agents/contributors working on this repository.

## What this project is

Internal **resilience testing** control plane: orchestration, governance,
measurement and scoring of load campaigns against **authorized** infrastructure.
Full-stack: Fastify/TypeScript backend (ESM, Node ≥ 22), React/Vite frontend.

## Non-negotiable boundary (must be respected absolutely)

The **control plane** (`backend/` + `frontend/` — the deployed product)
**implements no attack vector**: no L3/L4 flood, no amplification
(DNS/NTP/SSDP/CLDAP), no Smurf, no L7 exhaustion (Slowloris, RUDY, WebSocket
flood, XML bomb, browser botnet). The **only** vector is a **bounded HTTP
generator** (GET/POST, rate-capped, allowlisted target). External load
generation goes through **adapters** (`backend/src/agents/`) that delegate to
licensed tools (k6, Vegeta, Locust) operated by the team — never offensive code
here. Any contribution adding a volumetric/exhaustion vector to the control
plane is out of scope.

A **closed synthetic network lab** that models UDP-amplification traffic shape
for defensive measurement (no source-IP spoofing, no real reflector protocol,
hard caps, isolated `internal` network) lives in a **separate repository** —
[`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab) —
so the boundary is **structural, not conventional**: this control plane contains
**no attack vector at all**. The two connect only through a read-only, governed
verdict contract (see `docs/drs-validation-policy.md`). See `docs/safeguards.md`
and `docs/network-lab.md`.

## Commands

```bash
npm install
npm run typecheck        # backend + frontend
npm test                 # backend tests (Vitest)
npm run build            # build backend + frontend
npm run dev:api          # API in watch mode (tsx)
npm run dev:web          # Vite UI
npm run lint             # ESLint (if configured)
```

Deployment: `bash deploy/setup.sh` (systemd, loopback). See `docs/deployment.md`.

## Architecture (summary)

- `backend/src/app.ts` — `buildApp()`: routes + logic (injectable for tests).
- `backend/src/server.ts` — entry point: store, auth, scheduler, listen, graceful shutdown.
- `backend/src/engine/loadTest.ts` — bounded HTTP generator (phases, RPS cap, kill switch).
- `backend/src/agents/` — `AttackAgent` contract + builtin/k6/vegeta/locust adapters.
- `backend/src/modules/` — campaigns (CAM + scheduler), probe (+ kill switch), wrs (scoring + history), reports (campaign + compliance), metrics, audit.
- `backend/src/store/` — PostgreSQL persistence (+ best-effort TimescaleDB) or memory.
- `backend/src/auth/` — JWT HS256 + RBAC (engineer/officer/viewer).
- `frontend/src/` — React dashboard (login, campaigns, WRS, audit, live SSE progress).

Full docs: `docs/` (index in `docs/README.md`).

## Status / roadmap

`docs/roadmap.md` is the **source of truth** for what is built vs. planned.
Update it in the same PR that changes behaviour, and reconcile any external
brief or plan against it rather than trusting the brief's own status.

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
  on campaigns/playbooks; only the **`ciso`** role can change them (`limits:manage`,
  `PUT /api/limits`), always clamped ≤ the ceiling (`clampToCeiling`) and audited
  (`limits.update`). Enforcement reads the effective caps threaded from `app.ts`;
  the frontend reads them from `/health` (`hardCaps` = effective, `hardCapsCeiling`
  = ceiling). Never widen the ceiling to satisfy a request.
- Every change: `npm run typecheck && npm test && npm run build` must pass.
- Secrets are never committed; tokens are never logged (request serializer).
