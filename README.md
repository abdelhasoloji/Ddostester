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
- **Auth + RBAC** — JWT, engineer / officer / viewer / ciso roles (toggleable),
  runtime user management (officer) on top of immutable env-defined users.
- **Two-layer caps** — a frozen, immutable `HARD_CAPS` ceiling; the **CISO** role
  sets the effective operational limits from the UI, always clamped ≤ the ceiling
  and audited (`config/limits.ts`, `PUT /api/limits`).
- **Persistence** — PostgreSQL (memory fallback).
- **Scheduler** — scheduled + recurring campaign execution (CAM-01).
- **Playbooks** — one-click curated assessment sequences (bounded, still governed).
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

Docker (self-contained: builds the API image — backend + UI — plus PostgreSQL,
bound to `127.0.0.1:8080`):

```bash
POSTGRES_PASSWORD=change-me docker compose up -d --build   # core: db + api
```

Optional profiles: `--profile monitoring` (Prometheus + Grafana; set
`GRAFANA_PASSWORD`), `--profile proxy` (TLS/mTLS reverse proxy).

**Continuous deployment:** once the server runs a self-hosted GitHub Actions
runner, every push to `main` that passes CI deploys itself — no manual commands.
See [docs/operations.md](./docs/operations.md).

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

By design, the **control plane** (the deployed product) **includes no attack
vector**. The following are therefore **absent** from it:

- L3/L4 volumetric vectors: UDP/ICMP/SYN/ACK/RST flood, fragmentation,
  GRE/DTLS flood, DNS/NTP/SSDP/CLDAP reflection/amplification.
- L7 exhaustion vectors: Slowloris, RUDY, cache-bypass, brute-force,
  WebSocket flood, GraphQL abuse, XML bomb, “browser botnet”.
- Any traffic generation at an unbounded rate or toward a target outside the
  allowlist.

The control-plane generator is limited to lawful, capped and traceable
application HTTP requests, suitable for measuring the resilience of a service
you operate.

A **closed synthetic network lab** that models UDP-amplification traffic shape
for **defensive measurement** — with no source-IP spoofing, no real reflector
protocols, hard caps, and an isolated `internal` Docker network with no published
host ports — lives in a **separate repository**,
[`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab),
so the boundary is **structural**: this control plane contains no attack vector
at all. See [“Isolated synthetic UDP network lab”](#isolated-synthetic-udp-network-lab)
and [docs/security-and-governance.md](./docs/security-and-governance.md).

## Documentation

Full documentation — a grouped index — in [`docs/`](./docs/README.md). Topic hubs:
[overview](./docs/overview.md) ·
[architecture](./docs/architecture.md) ·
[security & governance](./docs/security-and-governance.md) ·
[boundary & lab](./docs/boundary-and-lab.md) ·
[measurement (WRS)](./docs/measurement.md) ·
[operations (deploy/CI)](./docs/operations.md) ·
[observability](./docs/observability.md) ·
[usage](./docs/usage.md) ·
[API](./docs/api.md) ·
[roadmap / status](./docs/roadmap.md).

## License

MIT — see [LICENSE](./LICENSE).

## Isolated synthetic UDP network lab

A closed Docker lab that reproduces UDP amplification traffic shape without
source-IP spoofing or public protocol reflectors — a **measurement model, not an
amplifier** — lives in its **own repository**:

> **https://github.com/abdelhasoloji/shieldtest-lab**

It was extracted so the boundary is **structural, not conventional**: this
control plane performs only bounded, allowlisted HTTP and contains no
amplification/spoofing/UDP code at all. The two connect only through a read-only,
governed verdict contract (see [`docs/boundary-and-lab.md`](docs/boundary-and-lab.md)).
See [`docs/boundary-and-lab.md`](docs/boundary-and-lab.md) for the split and the pointer.
