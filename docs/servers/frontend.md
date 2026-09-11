# Composant : Frontend (React / Vite)

**Sources** : `frontend/` (React + Vite), servi par l'API en production.

## Rôle

Interface web (React) du plan de contrôle : gestion des campagnes, approbations,
rapports, WRS, administration. En production elle est **buildée en statique** et
servie par le serveur API ; en développement elle tourne sur son propre serveur
Vite.

## Modes

| Mode                  | Commande                                         | Écoute                  | Source                                                |
| --------------------- | ------------------------------------------------ | ----------------------- | ----------------------------------------------------- |
| Développement         | `npm run dev -w frontend` (`vite`)               | `http://localhost:5173` | `frontend/package.json`, `frontend/vite.config.ts:48` |
| Production (statique) | `npm run build -w frontend` puis servi par l'API | via l'API `:8080`       | `frontend/package.json`, `app.ts:245-266`             |
| Preview               | `npm run preview -w frontend`                    | serveur Vite de preview | `frontend/package.json`                               |

## Service statique par l'API

Quand `frontend/dist` existe, l'API l'enregistre via `fastify-static`
(`app.ts:245-252`). Repli SPA : toute route qui n'est ni `/api` ni `/metrics`
renvoie `index.html` (deep links react-router) ; `/api`/`/metrics` inconnus
renvoient `404` (`app.ts:253-266`).

## Proxy de dev

En dev, Vite proxifie `/api` et `/health` vers l'API sur `http://localhost:8080`
(`frontend/vite.config.ts:49`), donc le frontend `:5173` parle au backend `:8080`
sans configuration CORS.

## Source de vérité des plafonds

Le frontend **ne code pas en dur** les plafonds : il lit `hardCaps` /
`hardCapsCeiling` depuis `/health` (`app.ts:762-764`, `config/limits.ts`), donc
l'UI reflète toujours l'application côté serveur.

## Déploiement

En Compose, un service `proxy` (Caddy) peut fronter l'ensemble en TLS/mTLS
(`docker-compose.yml:95-100`, `deploy/proxy/Caddyfile`). Détails :
`docs/deployment.md`, `docs/public-deployment.md`.
