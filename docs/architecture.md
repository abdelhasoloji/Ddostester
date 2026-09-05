# Architecture

## Vue d'ensemble

WEDOS ShieldTest (control plane) est une application full-stack :

- **Backend** — API REST Fastify/TypeScript. Elle sert aussi l'UI buildée
  (même origine → un seul service, un seul tunnel).
- **Frontend** — SPA React/Vite (tableau de bord des campagnes).

```
Navigateur (via tunnel SSH)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Backend Fastify (127.0.0.1:8080)            │
│                                              │
│  UI statique  ──  /            (frontend/dist)│
│                                              │
│  API                                         │
│   ├─ CAM    campagnes + workflow d'approbation│
│   ├─ GEN    générateur HTTP borné            │
│   ├─ PROBE  sonde légitime + kill switch     │
│   ├─ WRS    scoring de résilience (pur)      │
│   └─ RPT    rapport HTML                      │
└─────────────────────────────────────────────┘
        │ requêtes HTTP bornées + sonde
        ▼
   Cible autorisée (allowlist ALLOWED_TARGETS)
```

## Modules backend

| Module | Fichier | Rôle |
|--------|---------|------|
| CAM | `backend/src/modules/campaigns/{model,service}.ts` | Création, validation, workflow d'approbation, plafonds durs |
| Runner | `backend/src/modules/campaigns/runner.ts` | Orchestre générateur + sonde + kill switch, agrège les métriques, calcule le WRS |
| GEN | `backend/src/engine/loadTest.ts` | Générateur HTTP borné (allowlist, plafond RPS, respect du kill switch) |
| PROBE | `backend/src/modules/probe/probe.ts` | Sonde de disponibilité/latence + kill switch 3 niveaux |
| WRS | `backend/src/modules/wrs/scoring.ts` | Fonction pure de scoring (aucun trafic généré) |
| RPT | `backend/src/modules/reports/report.ts` | Rapport HTML traçable |
| Store | `backend/src/store/` | Persistance : PostgreSQL (`DATABASE_URL`) ou mémoire (repli) |
| Server | `backend/src/server.ts` | Routes HTTP, service UI, bind loopback, ordonnanceur |
| Scheduler | `backend/src/modules/campaigns/scheduler.ts` | Exécution planifiée des campagnes approuvées (CAM-01) |
| Auth | `backend/src/auth/` | JWT + RBAC (engineer/officer/viewer) |
| Audit | `backend/src/modules/audit/` | Journal d'audit persistant |

## Flux d'une campagne

```
1. Création           POST /api/campaigns          → PENDING_APPROVAL
   (validation : allowlist, attestation, plafonds HARD_CAPS)
2. Approbation        POST /api/campaigns/:id/approval → APPROVED / REJECTED
   (séparation des rôles, validité 24 h, rejet motivé)
3. Exécution          POST /api/campaigns/:id/execute → RUNNING
   ├─ générateur HTTP borné  ─┐
   ├─ sonde légitime          ├─ en parallèle, sous kill switch
   └─ kill switch (3 niveaux) ─┘
   → COMPLETED / KILLED_AUTO / KILLED_MANUAL
4. Scoring            calcul WRS à partir des métriques mesurées
5. Rapport            GET /api/runs/:runId/report  → HTML
```

## Kill switch (3 niveaux)

1. **Auto** — la sonde détecte une indisponibilité consécutive > 30 s.
2. **Manuel** — `POST /api/campaigns/:id/kill` (bouton SOC/NOC).
3. **Temporel** — timeout absolu = `maxDurationSec` (borné à 900 s / 15 min).

Le kill switch propage un `AbortSignal` : générateur et sonde s'arrêtent net.

## Stack technique

- Node ≥ 22, TypeScript strict, ESM.
- Fastify 5, `@fastify/static`, `@fastify/cors`.
- React 18, Vite 6.
- Persistance : PostgreSQL via `pg` (repli mémoire), schéma auto-créé.
- Tests : Vitest.
