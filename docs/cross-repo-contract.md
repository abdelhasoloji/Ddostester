# Contrat inter-dépôts : plan de contrôle ↔ banc `shieldtest-lab`

Les deux dépôts ne se rejoignent **que** par un contrat gouverné, en lecture
seule — **jamais** par un chemin d'attaque en direct. Le plan de contrôle
(`backend/` + `frontend/`) n'ouvre aucun socket d'amplification ; le banc
`shieldtest-lab` produit un verdict / résumé de métriques que le plan de contrôle
ingère en lecture seule. Cette fiche décrit le contrat **côté plan de contrôle** ;
la fiche miroir côté banc est dans `shieldtest-lab/docs/cross-repo-contract.md`.

> Boundary : l'amplification UDP est **classe C** (« bench réseau »). Le plan de
> contrôle ne l'exécute jamais (`backend/src/modules/bench/model.ts:1-7`,
> `docs/drs-validation-policy.md`).

## Les deux dépôts

| Dépôt                 | Rôle                                               | Remote                                    |
| --------------------- | -------------------------------------------------- | ----------------------------------------- |
| Ddostester (ce dépôt) | Plan de contrôle : gouvernance, mesure, scoring    | `github.com/abdelhasoloji/Ddostester`     |
| shieldtest-lab        | Banc synthétique isolé (le seul émetteur classe C) | `github.com/abdelhasoloji/shieldtest-lab` |

## Canal 1 — Dispatch gouverné (record-and-dispatch)

Le CISO enregistre une demande ; le runner du lab la réclame et reposte un
verdict. Le plan de contrôle n'émet aucun trafic.

| Étape       | Côté plan de contrôle                                                                | Côté lab                   |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------- |
| Demande     | `POST /api/bench/runs` (`bench:dispatch`) → `REQUESTED` (`app.ts:1010-1045`)         | —                          |
| Réclamation | `POST /api/bench/runs/next/claim` (Bearer `BENCH_RUNNER_TOKEN`) (`app.ts:1047-1054`) | `runner.mjs:22-27`         |
| Exécution   | —                                                                                    | `run-scenario.mjs` (borné) |
| Verdict     | `POST /api/bench/runs/:id/result` (`app.ts:1056-1118`)                               | `runner.mjs:34-38`         |

- Auth runner : jeton dédié, comparaison à temps constant, jamais un JWT
  utilisateur (`runnerAuthed`, `app.ts:987-994`).
- Le verdict n'est accepté que pour un run `CLAIMED` (sinon `409`)
  (`app.ts:1063-1068`) ; il n'apporte qu'un **nom de scénario allowlisté** au
  runner, jamais un host/débit/durée (`runner.mjs:9-11`).
- `LAB_TARGETS` ne recouvre jamais `ALLOWED_TARGETS` (`app.ts:139-145,975-984`).

## Canal 2 — Connecteurs de mesure (pull, lecture seule)

Le plan de contrôle **lit** les métriques exposées par le lab pour enrichir le
WRS d'un run.

| Mesure               | Endpoint du lab                                                               | Renvoie                                                 | Connecteur du plan de contrôle                                                                                 |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Détection/mitigation | scrubber `GET /protection` (`shieldtest-lab .../scrubber/server.mjs:249-253`) | `detectionTimeSec, mitigationTimeSec, strategy, source` | `PROTECTION_METRICS_URL` → `PollProtectionProvider` (`modules/protection/provider.ts:139-162`)                 |
| Charge hôte          | target `GET /telemetry` (`shieldtest-lab .../target/receiver.mjs:82-86`)      | `nicRxMbps`                                             | `TARGET_TELEMETRY_METRICS_URL` → `PollTargetTelemetryProvider` (`modules/target-telemetry/provider.ts:91-110`) |

Le plan de contrôle expose aussi un **adaptateur** `GET /api/protection/lab-metrics`
qui republie la dernière mesure du scrubber dans la forme attendue par
`PollProtectionProvider` (`app.ts:1138-1165`) ; il exige l'en-tête marqueur
`x-wedos-shieldtest: protection-query` et renvoie `404` sans mesure (jamais un
zéro fabriqué).

Les formes JSON des deux endpoints sont verrouillées côté lab par
`shieldtest-lab/test/closed-loop.test.mjs`.

## Propriétés de sûreté du contrat

- **Lecture seule** : le plan de contrôle ne fait que lire (pull) ou recevoir
  (verdict posté) ; il n'ouvre aucun socket d'amplification.
- **Fail-closed** : dispatch inactif sans `LAB_TARGETS` + `BENCH_RUNNER_TOKEN`
  (`app.ts:1011-1015`) ; runner inactif sans `BENCH_API_URL` + `BENCH_RUNNER_TOKEN`
  (`shieldtest-lab/runner.mjs:75-78`).
- **Classe C jamais postée en A/B** : le verdict est une preuve autonome, la
  couverture est enregistrée `MEASURED_LAB` (`app.ts:1085-1108`).

## Voir aussi

- Fiches serveur du plan de contrôle : [`servers/`](servers/README.md).
- `docs/drs-validation-policy.md` (politique de classe C).
- Côté banc : `shieldtest-lab/docs/cross-repo-contract.md` et
  `shieldtest-lab/docs/servers/`.
