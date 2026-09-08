# Architecture

## Overview

WEDOS ShieldTest (control plane) is a full-stack application:

- **Backend** — Fastify/TypeScript REST API. It also serves the built UI
  (same origin → a single service, a single tunnel).
- **Frontend** — React/Vite SPA (campaign dashboard).

```
Browser (via SSH tunnel)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Fastify backend (127.0.0.1:8080)            │
│                                              │
│  Static UI    ──  /            (frontend/dist)│
│                                              │
│  API                                         │
│   ├─ CAM    campaigns + approval workflow     │
│   ├─ GEN    bounded HTTP generator           │
│   ├─ PROBE  legitimate probe + kill switch   │
│   ├─ WRS    resilience scoring (pure)        │
│   └─ RPT    HTML report                       │
└─────────────────────────────────────────────┘
        │ bounded HTTP requests + probe
        ▼
   Authorized target (allowlist ALLOWED_TARGETS)
```

## Backend modules

| Module     | File                                                  | Purpose                                                                                                                                          |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CAM        | `backend/src/modules/campaigns/{model,service}.ts`    | Creation, validation, approval workflow, hard caps                                                                                               |
| Runner     | `backend/src/modules/campaigns/runner.ts`             | Orchestrates generator + probe + kill switch, aggregates metrics, computes WRS                                                                   |
| GEN        | `backend/src/engine/loadTest.ts`                      | Bounded HTTP generator (allowlist, RPS cap, phases, kill switch)                                                                                 |
| Scenarios  | `backend/src/engine/loadTest.ts` (phases)             | Bounded multi-phase profiles: ramp-up, waves (GEN-03)                                                                                            |
| PROBE      | `backend/src/modules/probe/probe.ts`                  | Availability/latency probe + 3-level kill switch                                                                                                 |
| WRS        | `backend/src/modules/wrs/{scoring,history}.ts`        | Scoring (pure function) + per-target history & regressions (WRS-03)                                                                              |
| RPT        | `backend/src/modules/reports/{report,compliance}.ts`  | Campaign report + DORA/NIS2 compliance report (HTML/PDF)                                                                                         |
| Metrics    | `backend/src/modules/metrics/prometheus.ts`           | Prometheus `/metrics` exposition                                                                                                                 |
| Store      | `backend/src/store/`                                  | Persistence: PostgreSQL (`DATABASE_URL`) or memory (fallback)                                                                                    |
| App        | `backend/src/app.ts`                                  | `buildApp()` factory: routes + logic (testable via inject), token-free logs                                                                      |
| Server     | `backend/src/server.ts`                               | Entry point: store, auth, scheduler, listen                                                                                                      |
| Scheduler  | `backend/src/modules/campaigns/scheduler.ts`          | Scheduled execution of approved campaigns (CAM-01)                                                                                               |
| Auth       | `backend/src/auth/`                                   | JWT + RBAC (engineer/officer/viewer/ciso)                                                                                                        |
| Limits     | `backend/src/config/limits.ts`                        | Frozen `HARD_CAPS` ceiling + CISO-set operational caps (`PUT /api/limits`)                                                                       |
| Audit      | `backend/src/modules/audit/`                          | Persistent audit log                                                                                                                             |
| Bench (C)  | `backend/src/modules/bench/model.ts`                  | Governed class-C dispatch: run requests/verdicts, coverage methods, attestation checklists, external import — **no attack vector, records only** |
| Playbooks  | `backend/src/modules/playbooks/{playbooks,suites}.ts` | Curated + custom assessment playbooks and consolidated suites                                                                                    |
| Notify     | `backend/src/modules/notify/`                         | Notification events + sinks (webhook/Slack), opt-in                                                                                              |
| Posture    | `backend/src/modules/posture/analyze.ts`              | Target posture fingerprint (WAF/CDN/rate-limit/LB signals)                                                                                       |
| Protection | `backend/src/modules/protection/`                     | Protection-provider hook for real detection/mitigation timing (default no-op)                                                                    |
| Telemetry  | `backend/src/modules/target-telemetry/`               | Target host telemetry correlated to the run (default no-op)                                                                                      |
| Users      | `backend/src/modules/users/service.ts`                | Runtime user management (officer); env users immutable                                                                                           |

## Campaign flow

```
1. Creation           POST /api/campaigns          → PENDING_APPROVAL
   (validation: allowlist, attestation, HARD_CAPS caps)
2. Approval           POST /api/campaigns/:id/approval → APPROVED / REJECTED
   (separation of duties, 24 h validity, rejection with reason)
3. Execution          POST /api/campaigns/:id/execute → RUNNING
   ├─ bounded HTTP generator ─┐
   ├─ legitimate probe        ├─ in parallel, under the kill switch
   └─ kill switch (3 levels)  ─┘
   → COMPLETED / KILLED_AUTO / KILLED_MANUAL
4. Scoring            WRS computed from the measured metrics
5. Report             GET /api/runs/:runId/report  → HTML
```

## Kill switch (3 levels)

1. **Auto** — the probe detects consecutive unavailability > 30 s.
2. **Manual** — `POST /api/campaigns/:id/kill` (SOC/NOC button).
3. **Time-based** — absolute timeout = `maxDurationSec` (capped at 900 s / 15 min).

The kill switch propagates an `AbortSignal`: generator and probe stop immediately.

## Technical stack

- Node ≥ 22, TypeScript strict, ESM.
- Fastify 5, `@fastify/static`, `@fastify/cors`.
- React 18, Vite 7.
- Persistence: PostgreSQL via `pg` (memory fallback), schema auto-created.
- Tests: Vitest.
