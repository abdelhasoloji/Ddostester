# Composant : Connecteurs de mesure (clients sortants)

**Sources** : `backend/src/modules/protection/provider.ts` (218 lignes),
`backend/src/modules/target-telemetry/provider.ts` (164 lignes).

Ces connecteurs sont des **clients HTTP sortants** que le plan de contrôle
utilise pour enrichir un run avec des mesures externes. Ils sont **best-effort** :
toute erreur retombe silencieusement sur l'estimation (jamais de valeur
fabriquée). Ils constituent, avec le [dispatch bench](bench-dispatch.md), le lien
mesuré vers le banc `shieldtest-lab`.

## Connecteur de protection (TTD/TTM)

Construit par précédence **webhook (push) > metrics (pull) > mock > aucun**
(`protection/provider.ts:194-217`).

| Variable                  | Défaut   | Effet                                                        | Source                      |
| ------------------------- | -------- | ------------------------------------------------------------ | --------------------------- |
| `PROTECTION_WEBHOOK_URL`  | (absent) | Push : POST de la fenêtre du run, lit les timings en réponse | `provider.ts:42,200-202`    |
| `PROTECTION_METRICS_URL`  | (absent) | Pull : GET d'un endpoint métriques (fenêtre en query)        | `provider.ts:43,204-206`    |
| `PROTECTION_TIMEOUT_MS`   | `5000`   | Timeout par requête                                          | `provider.ts:44,199`        |
| `PROTECTION_SOURCE_LABEL` | (absent) | Étiquette de provenance si le connecteur n'en fournit pas    | `provider.ts:45,110-117`    |
| `PROTECTION_MOCK`         | (absent) | `true` → timings fixes source `mock` (lab/démo)              | `provider.ts:34-40,208-215` |

- **Pull** (`PollProtectionProvider`) : GET avec `campaignId`, `target`, `from`,
  `to` en query et l'en-tête `x-wedos-shieldtest: protection-query`
  (`provider.ts:80-94,149-161`).
- **Forme de mesure** acceptée : `{ detectionTimeSec, mitigationTimeSec, source? }`,
  nombres ≥ 0, sinon rejetée (`parseMeasurement`, `provider.ts:97-108`).
- URLs validées http/https (`requireHttpUrl`, `provider.ts:177-188`).

Pointer `PROTECTION_METRICS_URL` sur `/api/protection/lab-metrics` du plan de
contrôle (voir [bench-dispatch.md](bench-dispatch.md)) fait consommer la mesure
**réelle** du scrubber du lab (`source: wedos-lab-scrubber`).

## Connecteur de télémétrie cible (compteurs hôte)

Construit par précédence **pull > mock > aucun**
(`target-telemetry/provider.ts:122-141`).

| Variable                       | Défaut   | Effet                            | Source                   |
| ------------------------------ | -------- | -------------------------------- | ------------------------ |
| `TARGET_TELEMETRY_METRICS_URL` | (absent) | Pull : GET des compteurs hôte    | `provider.ts:32,127-138` |
| `TARGET_TELEMETRY_TIMEOUT_MS`  | `3000`   | Timeout par requête              | `provider.ts:33,126`     |
| `TARGET_TELEMETRY_MOCK`        | (absent) | `true` → échantillon fixe (démo) | `provider.ts:21-30,139`  |

- **Pull** (`PollTargetTelemetryProvider`) : GET avec `campaignId`, `target` en
  query et l'en-tête `x-wedos-shieldtest: target-telemetry-query`
  (`provider.ts:49-63,100-109`).
- **Forme d'échantillon** : `{ cpuPct?, conntrack?, nicRxMbps?, nicTxMbps? }`,
  nombres ≥ 0 ; rejeté si aucune métrique (`parseTargetSample`,
  `provider.ts:66-89`).

Pointer `TARGET_TELEMETRY_METRICS_URL` sur l'endpoint `/telemetry` de la victime
du lab (qui renvoie `nicRxMbps`) corrèle la charge hôte au run.

## Correspondance avec le banc `shieldtest-lab`

| Endpoint du lab            | Renvoie                                                 | Connecteur du plan de contrôle                                 |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Scrubber `GET /protection` | `detectionTimeSec, mitigationTimeSec, strategy, source` | `PROTECTION_METRICS_URL` → `PollProtectionProvider`            |
| Target `GET /telemetry`    | `nicRxMbps`                                             | `TARGET_TELEMETRY_METRICS_URL` → `PollTargetTelemetryProvider` |

Les formes JSON sont verrouillées des deux côtés par des tests
(`shieldtest-lab/test/closed-loop.test.mjs`). Détail complet du contrat :
[`../cross-repo-contract.md`](../cross-repo-contract.md).
