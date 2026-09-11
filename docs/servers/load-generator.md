# Composant : Générateur de charge (le seul vecteur)

**Sources** : `backend/src/agents/` (adaptateurs), `backend/src/engine/`
(moteur intégré) · **Sélection** : `selectAgent` (`agents/index.ts:32-34`).

## Rôle

Le **seul** vecteur du plan de contrôle est un **générateur HTTP borné**
(GET/POST, plafonné en RPS, cible sur allowlist). Aucun vecteur volumétrique ou
d'épuisement n'existe ici (`CLAUDE.md`, frontière non négociable). Les moteurs
externes (k6, Vegeta, Locust…) sont des **adaptateurs** qui délèguent à des
outils sous licence opérés par l'équipe.

## Agents disponibles

Fabriques par id (`agents/index.ts:12-19`), ordre d'insertion = ordre affiché
(`AGENTS`, `agents/index.ts:22`) :

| Id        | Classe             | Fichier             | Nature                                        |
| --------- | ------------------ | ------------------- | --------------------------------------------- |
| `builtin` | `BuiltinHttpAgent` | `agents/builtin.ts` | Générateur HTTP intégré (aucun outil externe) |
| `k6`      | `K6Agent`          | `agents/k6.ts`      | Adaptateur k6                                 |
| `vegeta`  | `VegetaAgent`      | `agents/vegeta.ts`  | Adaptateur Vegeta                             |
| `locust`  | `LocustAgent`      | `agents/locust.ts`  | Adaptateur Locust                             |
| `jmeter`  | `JMeterAgent`      | `agents/jmeter.ts`  | Adaptateur JMeter                             |
| `gatling` | `GatlingAgent`     | `agents/gatling.ts` | Adaptateur Gatling                            |

Sélection par `AGENT` (défaut `builtin`) ; un id inconnu retombe sur le builtin
(`agents/index.ts:32-34`). Capacités par agent (multi-phase, flow, corrélation)
exposées par `describeAgents()` (`agents/index.ts:71-88`) et l'endpoint
`GET /api/agents` (`app.ts:823-831`).

## Agent intégré (`BuiltinHttpAgent`)

`agents/builtin.ts:8-27` :

- `name = 'builtin-http'`, `multiPhase`, `flowCapable`, `correlationCapable` tous
  `true` (`builtin.ts:9-12`) ; toujours disponible (`builtin.ts:15-17`).
- `run()` route vers `runSlowloris` si `config.slowloris`, sinon `runLoadTest`
  (`builtin.ts:18-26`).

## Moteur de charge (`engine/loadTest.ts`, 503 lignes)

- **Barrière anti-abus** : `validateConfig` rejette toute cible hors allowlist et
  tout test non explicitement autorisé (`config.authorized`)
  (`engine/loadTest.ts:53-58`, `TargetNotAllowedError`/`InvalidConfigError`
  `loadTest.ts:13-14`).
- **Bornes de forme** importées d'un point unique : `MAX_ENDPOINTS`,
  `MAX_FLOW_STEPS`, `MAX_THINK_MS`, `MAX_USER_AGENTS`, `MAX_DATASET_ROWS`,
  `HTTP_METHODS` (`loadTest.ts:3-9`, `engine/types.ts`).
- **Débit** : `iterationRate(maxRps, stepCount)` plafonne le débit d'un flow à N
  étapes pour que le total reste ≤ `maxRps` (`loadTest.ts:49-51`).
- Variante `engine/slowloris.ts` pour l'étude de l'épuisement lent (borné).

Tous les runs restent sous les `HARD_CAPS` (`config/limits.ts:31-38`, voir
[backend-api.md](backend-api.md)), jamais affaiblis par campagne ou par playbook.

## Kill switch

Le registre en mémoire `kills` détient les `AbortController` des runs en vol
(`runtime/kills.ts:8-16`) ; il alimente la garde de concurrence
(`kills.count()`) et permet l'arrêt manuel/auto/temporisé (`modules/probe/probe.ts`).
Détail : [bench-dispatch.md](bench-dispatch.md) pour l'arrêt, `docs/safeguards.md`.
