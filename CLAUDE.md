# CLAUDE.md — WEDOS ShieldTest (control plane)

Guide pour agents/contributeurs travaillant sur ce dépôt.

## Ce qu'est ce projet

Plan de contrôle interne de **test de résilience** : orchestration, gouvernance,
mesure et scoring de campagnes de charge contre une infrastructure **autorisée**.
Full-stack : backend Fastify/TypeScript (ESM, Node ≥ 22), frontend React/Vite.

## Limite non négociable (à respecter absolument)

Ce dépôt **n'implémente aucun vecteur d'attaque** : pas de flood L3/L4, pas
d'amplification (DNS/NTP/SSDP/CLDAP), pas de Smurf, pas d'épuisement L7
(Slowloris, RUDY, WebSocket flood, XML bomb, browser botnet). Le **seul** vecteur
est un générateur **HTTP borné** (GET/POST, débit plafonné, cible en liste
blanche). La génération de charge externe passe par des **adaptateurs**
(`backend/src/agents/`) qui délèguent à des outils licenciés (k6, Vegeta, Locust)
opérés par l'équipe — jamais du code offensif ici. Toute contribution ajoutant un
vecteur volumétrique/épuisement est hors périmètre. Voir `docs/safeguards.md`.

## Commandes

```bash
npm install
npm run typecheck        # backend + frontend
npm test                 # tests backend (Vitest)
npm run build            # build backend + frontend
npm run dev:api          # API en watch (tsx)
npm run dev:web          # UI Vite
npm run lint             # ESLint (si configuré)
```

Déploiement : `bash deploy/setup.sh` (systemd, loopback). Voir `docs/deployment.md`.

## Architecture (résumé)

- `backend/src/app.ts` — `buildApp()` : routes + logique (injectable pour tests).
- `backend/src/server.ts` — point d'entrée : store, auth, ordonnanceur, écoute, arrêt gracieux.
- `backend/src/engine/loadTest.ts` — générateur HTTP borné (phases, plafond RPS, kill switch).
- `backend/src/agents/` — contrat `AttackAgent` + adaptateurs builtin/k6/vegeta/locust.
- `backend/src/modules/` — campaigns (CAM + ordonnanceur), probe (+ kill switch), wrs (scoring + historique), reports (campagne + conformité), metrics, audit.
- `backend/src/store/` — persistance PostgreSQL (+ TimescaleDB best-effort) ou mémoire.
- `backend/src/auth/` — JWT HS256 + RBAC (engineer/officer/viewer).
- `frontend/src/` — dashboard React (login, campagnes, WRS, audit, progression live SSE).

Doc complète : `docs/` (index dans `docs/README.md`).

## Conventions

- TypeScript strict, ESM (imports en `.js`). Commentaires en français (cohérence repo).
- Garde-fous d'abord : allowlist, plafonds `HARD_CAPS`, attestation, approbation,
  kill switch, audit — ne jamais les contourner ni les affaiblir.
- Tout changement : `npm run typecheck && npm test && npm run build` doivent passer.
- Secrets jamais commités ; tokens jamais loggués (serializer de requête).
