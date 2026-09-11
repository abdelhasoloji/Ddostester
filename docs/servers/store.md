# Composant : Stockage (mémoire / PostgreSQL)

**Sources** : `backend/src/store/index.ts`, `store/types.ts`, `store/memory.ts`,
`store/postgres.ts`.

## Rôle

Persistance des campagnes, runs, audit, échantillons WRS, runs bench et
couverture. Deux implémentations derrière l'interface `Store` (`store/types.ts`).

## Sélection

`createStore()` choisit PostgreSQL si `DATABASE_URL` est défini, sinon un store
en mémoire ; le schéma est initialisé au démarrage (`store/index.ts:11-15`).

| Backend    | Condition              | Classe          | `backend`    | Source                                              |
| ---------- | ---------------------- | --------------- | ------------ | --------------------------------------------------- |
| PostgreSQL | `DATABASE_URL` présent | `PostgresStore` | `'postgres'` | `store/index.ts:12-13`, `store/postgres.ts:176-177` |
| Mémoire    | sinon (dev/tests)      | `MemoryStore`   | `'memory'`   | `store/index.ts:13`, `store/memory.ts:11-12`        |

Le champ `store.backend` est remonté par `/health` et `/ready`
(`app.ts:753,804`).

## Contrat `Store` (extrait vérifié, `store/types.ts`)

| Méthode                       | Rôle                                           | Source              |
| ----------------------------- | ---------------------------------------------- | ------------------- |
| `init()`                      | Initialise le schéma                           | `store/types.ts:16` |
| `healthy()`                   | Sonde de disponibilité (utilisée par `/ready`) | `store/types.ts:18` |
| `pruneOldData(days)`          | Purge runs/audit/samples au-delà de N jours    | `store/types.ts:23` |
| `claimNextBenchRun(runnerId)` | Réclame le prochain run bench pour le runner   | `store/types.ts:71` |
| `setBenchRunResult(...)`      | Enregistre verdict/erreur d'un run bench       | `store/types.ts:73` |
| `close()`                     | Ferme proprement (connexions DB)               | `store/types.ts:84` |

## Déploiement

En Compose, le service `db` (image `postgres:16` par défaut) fournit PostgreSQL
(`docker-compose.yml:4-13`) ; l'API le consomme via `DATABASE_URL`. La purge
quotidienne est pilotée par `RETENTION_DAYS` côté serveur (voir
[backend-api.md](backend-api.md)).
