# Référence des serveurs — WEDOS ShieldTest (plan de contrôle)

Documentation détaillée des composants réseau (« serveurs ») du plan de contrôle,
**ancrée au code** : chaque valeur (port, variable d'env, endpoint, garde, plafond)
est citée en `fichier:ligne` et vérifiée dans le code, jamais rédigée de mémoire.
Quand le code ne précise pas une chose, la fiche l'écrit (« non spécifié dans le
code ») au lieu d'inventer.

> Cette référence complète la doc existante (`docs/api.md`, `docs/architecture.md`,
> `docs/auth.md`, `docs/drs-validation-policy.md`…) : elle se concentre sur les
> **processus qui écoutent le réseau** et leur configuration runtime, et renvoie à
> ces documents pour le détail fonctionnel.

## Frontière non négociable

Le plan de contrôle (`backend/` + `frontend/`) **n'implémente aucun vecteur
d'attaque** : pas de flood L3/L4, pas d'amplification, pas d'épuisement L7. Le
**seul** vecteur est un **générateur HTTP borné** (GET/POST, plafonné, allowlist).
L'amplification UDP est **classe C** et n'est **jamais** exécutée ici : elle est
mesurée dans un dépôt séparé, le banc `shieldtest-lab`, via un **contrat gouverné
en lecture seule**. Voir [`../cross-repo-contract.md`](../cross-repo-contract.md)
et `CLAUDE.md`.

## Les serveurs / composants

| Composant                 | Type                              | Écoute                             | Source                                                     | Fiche                                  |
| ------------------------- | --------------------------------- | ---------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| API du plan de contrôle   | Serveur HTTP (Fastify)            | `127.0.0.1:8080` (défaut)          | `backend/src/server.ts`, `backend/src/app.ts`              | [backend-api.md](backend-api.md)       |
| Générateur de charge      | Vecteur HTTP borné + adaptateurs  | sortant (vers cible autorisée)     | `backend/src/agents/`, `backend/src/engine/`               | [load-generator.md](load-generator.md) |
| Dispatch bench (classe C) | Surface HTTP + client de file     | routes `/api/bench/*`              | `backend/src/app.ts`, `backend/src/modules/bench/`         | [bench-dispatch.md](bench-dispatch.md) |
| Connecteurs de mesure     | Clients HTTP sortants (pull/push) | vers le lab                        | `backend/src/modules/protection/`, `.../target-telemetry/` | [connectors.md](connectors.md)         |
| Stockage                  | Backend mémoire ou PostgreSQL     | selon `DATABASE_URL`               | `backend/src/store/`                                       | [store.md](store.md)                   |
| Frontend                  | Serveur statique / Vite           | build servi par l'API, dev `:5173` | `frontend/`                                                | [frontend.md](frontend.md)             |

## Ancrages transverses vérifiés

- **Bind par défaut loopback**, refus des adresses publiques/toutes-interfaces sauf
  `ALLOW_PUBLIC_BIND=1` (`backend/src/util/bind.ts:55-86`, `server.ts:39-45`).
- **Plafonds durs** `HARD_CAPS` figés : `maxRps 2000`, `maxConcurrency 500`,
  `maxDurationSec 900` (`backend/src/config/limits.ts:31-38`), resserrables par le
  CISO mais jamais au-dessus du plafond (`clampToCeiling`, `app.ts:776-800`).
- **En-têtes de sécurité** sur chaque réponse + CSP stricte (`app.ts:207-224`).
- **RBAC** par `guard(permission)` (`app.ts:227-235`).
