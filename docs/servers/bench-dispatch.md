# Composant : Dispatch bench classe C (côté plan de contrôle)

**Sources** : `backend/src/app.ts` (routes `/api/bench/*`),
`backend/src/modules/bench/model.ts` (scénarios, verdict).

## Rôle

Le plan de contrôle **enregistre et sert** des demandes de run de classe C
(bench réseau, ex. amplification UDP) mais **n'émet jamais** ce trafic. Un
**runner isolé externe** (le dépôt `shieldtest-lab`) réclame le travail,
l'exécute dans le lab, et **reposte un verdict en lecture seule**. C'est le pont
gouverné entre les deux dépôts. Voir
[`../cross-repo-contract.md`](../cross-repo-contract.md).

## Activation (fail-closed)

Le dispatch n'est actif que si `LAB_TARGETS` **et** `BENCH_RUNNER_TOKEN` sont
configurés (`benchDispatchEnabled()`, cité par `app.ts:1011-1015`). Sinon
`POST /api/bench/runs` renvoie 400. `LAB_TARGETS` ne doit pas recouvrir
`ALLOWED_TARGETS` (garde fail-closed, `app.ts:139-145`).

## Scénarios (`modules/bench/model.ts:87+`)

Catalogue `BENCH_SCENARIOS`. Seuls les scénarios `reproducible: true` sont
dispatchables (`DISPATCHABLE`, `bench/model.ts:178`).

| Id                       | Titre                   | DRS | Reproductible (dispatchable) | Source               |
| ------------------------ | ----------------------- | --- | ---------------------------- | -------------------- |
| `udp_dns_reflection`     | UDP DNS Reflection      | 3   | oui                          | `bench/model.ts:87+` |
| `tcp_synflood`           | TCP SynFlood            | 3   | oui                          | `bench/model.ts`     |
| `udp_maxpackets`         | UDP MaxPackets          | 3   | oui                          | `bench/model.ts`     |
| `tcp_maxpackets`         | TCP MaxPackets          | 3   | oui                          | `bench/model.ts`     |
| `udp_multivector`        | UDP MultiVector         | 4   | oui                          | `bench/model.ts`     |
| `ip_spoofing`            | IP Spoofing             | 4   | non                          | `bench/model.ts`     |
| `udp_fragmentation`      | UDP Fragmentation       | 4   | non                          | `bench/model.ts`     |
| `tcp_fragmentation`      | TCP Fragmentation       | 4   | non                          | `bench/model.ts`     |
| `tcp_multivector`        | TCP MultiVector         | 4   | non                          | `bench/model.ts`     |
| `multiproto_multivector` | Multi-proto MultiVector | 5   | non                          | `bench/model.ts`     |
| `gre_packets`            | GRE Packets             | 5   | non                          | `bench/model.ts`     |

Les vecteurs non reproductibles (spoofing/fragmentation/GRE…) sont **hors modèle**
du banc et ne peuvent pas être dispatchés.

## Endpoints

### Gouvernance (utilisateur, RBAC)

| Méthode  | Chemin                    | Garde                       | Rôle                                   | Source             |
| -------- | ------------------------- | --------------------------- | -------------------------------------- | ------------------ |
| GET      | `/api/bench/scenarios`    | `bench:read`                | Catalogue + état dispatch + labTargets | `app.ts:995-999`   |
| GET      | `/api/bench/runs`         | `bench:read`                | Liste des runs                         | `app.ts:1001`      |
| GET      | `/api/bench/runs/:id`     | `bench:read`                | Un run                                 | `app.ts:1005`      |
| POST     | `/api/bench/runs`         | `bench:dispatch`            | Enregistre une demande `REQUESTED`     | `app.ts:1010-1045` |
| GET      | `/api/bench/coverage`     | `bench:read`                | Matrice de couverture                  | `app.ts:1120`      |
| POST     | `/api/bench/coverage`     | `bench:attest`              | Preuve de couverture (non-run)         | `app.ts:1166`      |
| GET/POST | `/api/bench/attestations` | `bench:read`/`bench:attest` | Attestations                           | `app.ts:1188-1192` |

`POST /api/bench/runs` valide le scénario (`isKnownBenchScenario`) et impose un
`labTarget` appartenant à `LAB_TARGETS` et **jamais** à `ALLOWED_TARGETS`
(`benchLabTarget`, `app.ts:975-984,1016-1039`).

### API du runner (jeton dédié, jamais un JWT utilisateur)

Authentification par `BENCH_RUNNER_TOKEN` en Bearer, comparaison à temps constant
(`runnerAuthed`, `app.ts:987-994`).

| Méthode | Chemin                       | Comportement                                    | Source             |
| ------- | ---------------------------- | ----------------------------------------------- | ------------------ |
| POST    | `/api/bench/runs/next/claim` | Réclame le prochain `REQUESTED` → `204` si vide | `app.ts:1047-1054` |
| POST    | `/api/bench/runs/:id/result` | Poste le verdict ou l'erreur                    | `app.ts:1056-1118` |

`/result` n'accepte un verdict que pour un run en état `CLAIMED` (sinon `409`),
ce qui rend le post idempotent-safe (`app.ts:1063-1068`). Un verdict valide
(`parseBenchVerdict`) enregistre aussi une ligne de couverture `MEASURED_LAB`
(`app.ts:1085-1108`).

## Adaptateur de métriques de protection

`GET /api/protection/lab-metrics` (`app.ts:1138-1165`) expose la dernière mesure
de détection/mitigation du scrubber du lab, **dans la forme exacte** attendue par
le connecteur pull `PROTECTION_METRICS_URL` (voir [connectors.md](connectors.md)) :

```json
{ "detectionTimeSec": <n>, "mitigationTimeSec": <n|0>,
  "source": "wedos-lab-scrubber", "strategy": "...",
  "scenario": "...", "measuredAt": "..." }
```

- Pas de garde utilisateur : le connecteur GET en loopback avec l'en-tête marqueur
  `x-wedos-shieldtest: protection-query` **obligatoire**, sinon `404`
  (`app.ts:1155-1157`).
- `404` quand aucune mesure de mitigation n'existe encore (jamais un zéro fabriqué)
  (`app.ts:1147-1149,1159-1161`).
- `mitigationTimeSec` = `detectionSec` si le scrubber s'est engagé, sinon `0`
  (`app.ts:1150-1153`).
