# WEDOS ShieldTest — Control Plane

Plateforme interne de **test de résilience** (control plane) inspirée du TSD
*WEDOS ShieldTest v1.0*. Elle sert à orchestrer, gouverner, mesurer et scorer
des campagnes de test de charge contre une infrastructure **que l'organisation
possède ou pour laquelle elle dispose d'un mandat écrit**.

> ⚠️ **Périmètre volontairement défensif.** Ce dépôt implémente le *plan de
> contrôle* : gestion de campagnes, workflow d'approbation, sonde de mesure,
> kill switch, scoring WRS et rapports. Le **seul vecteur de charge** fourni est
> un générateur **HTTP applicatif borné** (GET/POST) soumis à liste blanche et
> plafond de débit. Voir [« Ce qui n'est pas implémenté »](#ce-qui-nest-pas-implémenté).

## Architecture

```
Frontend (React/Vite)  ──►  API (Fastify/TS)
                              ├─ CAM     campagnes + workflow d'approbation
                              ├─ GEN     générateur HTTP borné (allowlist + RPS cap)
                              ├─ PROBE   sonde légitime + kill switch (auto/manuel/temporel)
                              ├─ WRS     scoring de résilience (fonction pure)
                              └─ RPT     rapport HTML traçable
```

## Garde-fous (safeguards)

- **Liste blanche obligatoire** (`ALLOWED_TARGETS`) : toute cible ou sonde hors
  liste est refusée. Seuls `http`/`https` sont acceptés.
- **Attestation d'autorisation** : une campagne exige `authorized: true`.
- **Plafonds durs non contournables** (`HARD_CAPS`) : `maxRps ≤ 2000`,
  `concurrency ≤ 500`, `durée ≤ 900 s` (timeout temporel absolu = 15 min).
- **Workflow d'approbation** : PENDING_APPROVAL → APPROVED/REJECTED, séparation
  des rôles (approbateur ≠ auteur), validité 24 h, rejet motivé.
- **Kill switch 3 niveaux** : auto (indispo > 30 s), manuel (SOC/NOC), temporel.
- **Marquage de trafic** : chaque requête porte l'en-tête `X-WEDOS-TEST`.

## Démarrage

```bash
npm install
cp .env.example .env          # renseigner ALLOWED_TARGETS
npm run dev:api               # API sur :8080
npm run dev:web               # UI sur :5173 (proxy /api → :8080)
npm test                      # tests backend
# Persistance : définir DATABASE_URL (PostgreSQL) ; sinon stockage mémoire.
```

Déploiement serveur (Ubuntu, Node 22, systemd) — un seul service qui sert l'API **et** l'UI, en loopback :

```bash
bash deploy/setup.sh              # build + service + health check
# accès distant, sans exposition publique :
ssh -L 8080:127.0.0.1:8080 user@serveur   # puis http://localhost:8080
```

Docker :

```bash
docker compose up --build
```

## API

| Méthode | Route | Rôle |
|--------|-------|------|
| GET  | `/health` | état + cibles autorisées |
| POST | `/api/campaigns` | créer une campagne (PENDING_APPROVAL) |
| GET  | `/api/campaigns` | lister |
| POST | `/api/campaigns/:id/approval` | approuver / rejeter |
| POST | `/api/campaigns/:id/execute` | exécuter une campagne approuvée |
| POST | `/api/campaigns/:id/kill` | kill switch manuel |
| GET  | `/api/runs/:runId` | résultat d'exécution + WRS |
| GET  | `/api/runs/:runId/report` | rapport HTML |

## WRS — WEDOS Resiliency Score

`WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C` (TSD §5.4), fonction pure et testée
(`backend/src/modules/wrs/scoring.ts`). Elle ne génère aucun trafic : elle
agrège des métriques mesurées.

## Ce qui n'est PAS implémenté

Par choix de conception, ce control plane **n'inclut aucun vecteur d'attaque**.
Sont donc **absents** (et hors périmètre de ce dépôt) :

- Vecteurs volumétriques L3/L4 : UDP/ICMP/SYN/ACK/RST flood, fragmentation,
  GRE/DTLS flood, réflexion/amplification DNS/NTP/SSDP/CLDAP.
- Vecteurs d'épuisement L7 : Slowloris, RUDY, cache-bypass, brute-force,
  WebSocket flood, GraphQL abuse, XML bomb, « browser botnet ».
- Toute génération de trafic à débit non borné ou vers une cible hors allowlist.

Le générateur fourni se limite à des requêtes HTTP applicatives licites,
plafonnées et traçables, adaptées à la mesure de résilience d'un service qu'on
administre.

## Documentation

Documentation complète dans [`docs/`](./docs/) :
[architecture](./docs/architecture.md) ·
[déploiement](./docs/deployment.md) ·
[utilisation](./docs/usage.md) ·
[API](./docs/api.md) ·
[WRS](./docs/wrs.md) ·
[sécurité & périmètre](./docs/safeguards.md).

## Licence

MIT — voir [LICENSE](./LICENSE).
