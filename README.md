# WEDOS ShieldTest — Control Plane

Internal **resilience testing** platform (control plane) inspired by the TSD
_WEDOS ShieldTest v1.0_. It orchestrates, governs, measures and scores load-test
campaigns against infrastructure **that the organization owns or holds a written
authorization to test**.

> ⚠️ **Deliberately defensive scope.** This repository implements the _control
> plane_: campaign management, approval workflow, measurement probe, kill
> switch, WRS scoring and reports. The **only load vector** provided is a
> **bounded application HTTP generator** (GET/POST) subject to an allowlist and a
> rate cap. See [“What is NOT implemented”](#what-is-not-implemented).

## Features

- **CAM** — campaigns + approval workflow (separation of duties, 24 h validity).
- **GEN** — bounded HTTP generator (allowlist + RPS cap), the only vector.
- **PROBE** — legitimate probe + 3-level kill switch (auto / manual / time-based).
- **WRS** — resilience scoring + **per-target history & regression detection**.
- **RPT** — HTML campaign report + **aggregated compliance report (DORA/NIS2)**.
- **Auth + RBAC** — JWT, engineer / officer / viewer roles (toggleable), runtime
  user management (officer) on top of immutable env-defined users.
- **Persistence** — PostgreSQL (memory fallback).
- **Scheduler** — scheduled campaign execution (CAM-01).
- **Audit** — persistent audit log of every action.
- **Monitoring** — Prometheus `/metrics` endpoint.
- **Notifications** — opt-in Slack / webhook alerts on completion, kill and WRS regression.

## Architecture

```
Frontend (React/Vite)  ──►  API (Fastify/TS)  ──►  PostgreSQL (or memory)
   login + RBAC              ├─ Auth (JWT) + RBAC
   dashboard + WRS chart     ├─ CAM  campaigns + approval
                             ├─ GEN  bounded HTTP generator (allowlist + RPS cap)
                             ├─ PROBE probe + kill switch (auto/manual/time-based)
                             ├─ WRS  scoring + history + regressions
                             ├─ RPT  campaign report + DORA/NIS2 compliance
                             ├─ Scheduler  scheduled execution (CAM-01)
                             ├─ Audit  persistent log
                             └─ /metrics  Prometheus
```

## Safeguards

- **Mandatory allowlist** (`ALLOWED_TARGETS`): any target or probe outside the
  list is rejected. Only `http`/`https` are accepted.
- **Authorization attestation**: a campaign requires `authorized: true`.
- **Hard, non-bypassable caps** (`HARD_CAPS`): `maxRps ≤ 2000`,
  `concurrency ≤ 500`, `duration ≤ 900 s` (absolute time-based timeout = 15 min).
- **Approval workflow**: PENDING_APPROVAL → APPROVED/REJECTED, separation of
  duties (approver ≠ author), 24 h validity, rejection with a reason.
- **3-level kill switch**: auto (unavailable > 30 s), manual (SOC/NOC), time-based.
- **Traffic tagging**: every request carries the `X-WEDOS-TEST` header.

## Getting started

```bash
npm install
cp .env.example .env          # set ALLOWED_TARGETS
npm run dev:api               # API on :8080
npm run dev:web               # UI on :5173 (proxy /api → :8080)
npm test                      # backend tests
# Persistence: set DATABASE_URL (PostgreSQL); otherwise in-memory storage.
```

Server deployment (Ubuntu, Node 22, systemd) — a single service serving the API
**and** the UI, on loopback:

```bash
bash deploy/setup.sh              # build + service + health check
# remote access, without public exposure:
ssh -L 8080:127.0.0.1:8080 user@server   # then http://localhost:8080
```

Docker:

```bash
docker compose up --build
```

**Continuous deployment:** once the server runs a self-hosted GitHub Actions
runner, every push to `main` that passes CI deploys itself — no manual commands.
See [docs/ci-cd.md](./docs/ci-cd.md).

## API

| Method | Route                         | Purpose                              |
| ------ | ----------------------------- | ------------------------------------ |
| GET    | `/health`                     | status + allowed targets             |
| POST   | `/api/campaigns`              | create a campaign (PENDING_APPROVAL) |
| GET    | `/api/campaigns`              | list                                 |
| POST   | `/api/campaigns/:id/approval` | approve / reject                     |
| POST   | `/api/campaigns/:id/execute`  | execute an approved campaign         |
| POST   | `/api/campaigns/:id/kill`     | manual kill switch                   |
| GET    | `/api/runs/:runId`            | run result + WRS                     |
| GET    | `/api/runs/:runId/report`     | HTML report                          |
| POST   | `/api/notify/test`            | send a test notification             |

## WRS — WEDOS Resiliency Score

`WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C` (TSD §5.4), a pure, tested function
(`backend/src/modules/wrs/scoring.ts`). It generates no traffic: it aggregates
measured metrics.

## What is NOT implemented

By design, this control plane **includes no attack vector**. The following are
therefore **absent** (and out of scope for this repository):

- L3/L4 volumetric vectors: UDP/ICMP/SYN/ACK/RST flood, fragmentation,
  GRE/DTLS flood, DNS/NTP/SSDP/CLDAP reflection/amplification.
- L7 exhaustion vectors: Slowloris, RUDY, cache-bypass, brute-force,
  WebSocket flood, GraphQL abuse, XML bomb, “browser botnet”.
- Any traffic generation at an unbounded rate or toward a target outside the
  allowlist.

The provided generator is limited to lawful, capped and traceable application
HTTP requests, suitable for measuring the resilience of a service you operate.

## Documentation

Full documentation in [`docs/`](./docs/):
[architecture](./docs/architecture.md) ·
[deployment](./docs/deployment.md) ·
[usage](./docs/usage.md) ·
[API](./docs/api.md) ·
[WRS](./docs/wrs.md) ·
[notifications](./docs/notifications.md) ·
[security & scope](./docs/safeguards.md).

## License

MIT — see [LICENSE](./LICENSE).
