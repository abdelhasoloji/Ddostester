# Serveur : API du plan de contrôle (Fastify)

**Sources** : `backend/src/server.ts` (177 lignes, entrée), `backend/src/app.ts`
(1763 lignes, `buildApp`) · **Stack** : Fastify / TypeScript ESM, Node ≥ 22.

## Rôle

Serveur HTTP unique qui orchestre, gouverne, mesure et score les campagnes de
test de résilience contre une infrastructure **autorisée**. Il sert aussi l'UI
React (statique) et expose la surface `/api/*`, plus `/health`, `/ready`,
`/metrics`.

## Écoute et bind

| Élément               | Défaut      | Variable                | Source         |
| --------------------- | ----------- | ----------------------- | -------------- |
| Port                  | `8080`      | `PORT` (entier positif) | `server.ts:34` |
| Host                  | `127.0.0.1` | `HOST`                  | `server.ts:39` |
| Autoriser bind public | refusé      | `ALLOW_PUBLIC_BIND=1`   | `server.ts:40` |

Le bind passe par `decideBind` (`server.ts:40`, `util/bind.ts:55-86`) :

- **loopback** (`127.0.0.1`, `localhost`, `::1`) → autorisé (`bind.ts:57`) ;
- **privé** (RFC1918, link-local) → autorisé avec avertissement « firewall vers le
  runner du lab seulement » (`bind.ts:58-66`) ;
- **public / toutes interfaces** (`0.0.0.0`, `::`, `*`, IP publique) → **refusé**
  sauf `ALLOW_PUBLIC_BIND=1`, sinon `process.exit(1)` (`bind.ts:67-85`, `server.ts:41-44`).

## TLS (sortant)

Politique appliquée une fois au démarrage, avant toute connexion sortante
(`server.ts:20-21`, `util/tls.ts:22-31`) :

- Préféré : `NODE_EXTRA_CA_CERTS` (CA interne, vérification TLS conservée).
- Échappatoire **lab isolé uniquement** : `INSECURE_TLS=true` désactive la
  vérification TLS pour toutes les requêtes sortantes du process
  (`util/tls.ts:13-14,22-30`).

## Configuration (env, lue dans `server.ts`)

| Variable                | Défaut                | Effet                                                        | Source                                      |
| ----------------------- | --------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `PORT`                  | `8080`                | Port d'écoute                                                | `server.ts:34`                              |
| `HOST`                  | `127.0.0.1`           | Adresse de bind                                              | `server.ts:39`                              |
| `ALLOW_PUBLIC_BIND`     | (absent)              | `=1` autorise un bind public                                 | `server.ts:40`                              |
| `ALLOWED_TARGETS`       | `localhost,127.0.0.1` | Hôtes cibles autorisés (≥ 1)                                 | `server.ts:46-52`                           |
| `LAB_TARGETS`           | (vide)                | Cibles lab isolées, sans recouvrement avec `ALLOWED_TARGETS` | `server.ts:55-58`, `app.ts:139-145`         |
| `BENCH_RUNNER_TOKEN`    | (vide)                | Jeton du runner bench ; vide = dispatch désactivé            | `server.ts:59-61`                           |
| `SCHEDULER`             | `on`                  | `off` désactive le planificateur                             | `server.ts:62`                              |
| `SCHEDULER_INTERVAL_MS` | `30000`               | Intervalle du planificateur                                  | `server.ts:63`                              |
| `RETENTION_DAYS`        | `90`                  | Purge des données au-delà                                    | `server.ts:64,131-146`                      |
| `MAX_CONCURRENT_RUNS`   | `3`                   | Garde de concurrence des runs                                | `server.ts:65`                              |
| `REQUIRE_CISO_APPROVAL` | (absent)              | `=1` impose un aval CISO par campagne                        | `server.ts:86`                              |
| `PROMETHEUS_URL`        | (absent)              | Base Prometheus pour les charts natifs                       | `server.ts:87`                              |
| `CORS_ORIGIN`           | (same-origin)         | Origines CORS autorisées (séparées par virgule)              | `app.ts:181-186`                            |
| `DATABASE_URL`          | (absent)              | PostgreSQL si présent, sinon mémoire                         | voir [store.md](store.md)                   |
| `AGENT`                 | `builtin`             | Agent de charge sélectionné                                  | voir [load-generator.md](load-generator.md) |

> La liste exhaustive des variables (notifications, protection, télémétrie, etc.)
> figure dans `.env.example` à la racine ; les fiches
> [bench-dispatch](bench-dispatch.md) et [connectors](connectors.md) détaillent
> celles du contrat inter-dépôts.

## Sécurité de la requête/réponse

- **CORS** same-origin par défaut ; `origin:false` sauf `CORS_ORIGIN`
  (`app.ts:181-186`).
- **En-têtes de sécurité** sur chaque réponse : `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CSP stricte
  (`app.ts:207-224`).
- **Logs** : l'`Authorization` est masquée et `?token=` est expurgé de l'URL logée
  (`app.ts:167-178`).
- **RBAC** : `guard(perm)` renvoie 401 sans identité, 403 sans la permission
  (`app.ts:227-235`). Détails des rôles : `docs/auth.md`.

## Plafonds durs (`HARD_CAPS`)

Source de vérité unique, figée (`config/limits.ts:31-38`) :

| Cap              | Valeur         | Source                |
| ---------------- | -------------- | --------------------- |
| `maxRps`         | `2000`         | `config/limits.ts:33` |
| `maxConcurrency` | `500`          | `config/limits.ts:35` |
| `maxDurationSec` | `900` (15 min) | `config/limits.ts:37` |

Le CISO fixe des **limites opérationnelles** ≤ plafond via `PUT /api/limits`,
re-clampées côté serveur (`clampToCeiling`, `app.ts:776-800`,
`config/limits.ts`). `/health` expose `hardCaps` (effectives) et
`hardCapsCeiling` (plafond immuable) (`app.ts:762-764`).

## Endpoints d'infrastructure

| Méthode | Chemin        | Réponse                                    | Source                          |
| ------- | ------------- | ------------------------------------------ | ------------------------------- |
| GET     | `/health`     | Posture + version + caps + storage + agent | `app.ts:740-765`                |
| GET     | `/ready`      | `200`/`503` selon la santé du store        | `app.ts:801-805`                |
| GET     | `/metrics`    | Prometheus texte (business + runtime)      | `routes/read-routes.ts:170-175` |
| GET     | `/api/limits` | Plafond + limites effectives               | `app.ts:768-771`                |
| PUT     | `/api/limits` | (CISO) fixe les limites opérationnelles    | `app.ts:776-800`                |

## Surface API (par domaine)

~44 routes montées dans `app.ts` et `routes/read-routes.ts`. Le détail par route
est dans `docs/api.md` ; carte par domaine, avec l'ancrage :

| Domaine                  | Routes (préfixe)                                     | Source                                      |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| Auth                     | `/api/auth/login`, `/api/auth/me`                    | `app.ts:853-882,1251`                       |
| Utilisateurs (RBAC)      | `/api/users`, `/api/users/:email`                    | `app.ts:1265-1336`                          |
| Campagnes                | `/api/campaigns`, `/api/campaigns/:id`, `.../stream` | `app.ts:1337-1360,1686`                     |
| Playbooks / suites       | `/api/playbooks*`, `/api/suites*`                    | `app.ts:1360-1657`                          |
| Runs / rapports          | `/api/runs*`, `/api/reports/*`, `*.csv`              | `routes/read-routes.ts:219-282`             |
| WRS / audit / alertes    | `/api/wrs/history`, `/api/audit*`, `/api/alerts`     | `routes/read-routes.ts:165-199`             |
| Recon / agents / limites | `/api/recon`, `/api/agents`, `/api/limits`           | `app.ts:823-852,768-800`                    |
| Bench (classe C)         | `/api/bench/*`, `/api/protection/lab-metrics`        | voir [bench-dispatch.md](bench-dispatch.md) |
| Observabilité            | `/api/observability/summary`, `/api/metrics/range`   | `routes/read-routes.ts:79-115,193`          |

## Cycle de vie & tâches d'arrière-plan

- **Réconciliation au boot** : les campagnes `RUNNING` orphelines repassent
  `APPROVED` (`server.ts:98-103`, `runtime/reconcile.ts`).
- **Planificateur** (si `SCHEDULER≠off`) : exécute les campagnes dues, garde
  anti-concurrence via le registre `kills` (`server.ts:106-128`).
- **Rétention** : purge quotidienne au-delà de `RETENTION_DAYS` (`server.ts:131-146`).
- **Arrêt gracieux** : `SIGTERM`/`SIGINT` ferment l'API puis le store
  (`server.ts:148-165`).
