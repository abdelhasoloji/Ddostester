# Campagnes et gestion de la flotte IoT

## Mesures et parcours unifié — lots 2 et 3

La préparation de campagne permet une sélection explicite de un à trois appareils
du groupe VPS Lab. Les IDs sont conservés dans la campagne et la commande ; seuls
les agents sélectionnés reçoivent une part du budget global. Sans sélection
explicite, les anciennes campagnes gardent le défaut des trois agents.

Fleet affiche disponibilité, affectation aux campagnes, échéance d'enrôlement,
capacités GET effectivement prises en charge et liens vers le Theater. Les profils
sensor/camera/gateway restent des étiquettes d'inventaire : aucun POST métier n'est
annoncé comme disponible. L'expiration des certificats n'est pas encore remontée.
Le Command Center reprend un résumé ; la liste des campagnes affiche leur moteur
et le nombre d'agents ; les templates proposent un parcours Fleet GET compatible
et conservent les moteurs déclarés des suites. Les anciennes missions privées et
les diagnostics sont rangés dans un panneau secondaire. Leur arrêt ferme aussi
le kill switch de campagne lorsqu'une mission est rattachée à une campagne.

Le rapport HTML et la vue de résultat détaillent budget, RPS réel, requêtes,
réponses, erreurs, annulations, latence et ressources par agent. Les observations
de sonde restent indépendantes, corrélées au run et séparées des compteurs agents.
L'export JSON conserve les mêmes IDs et la fenêtre de génération, sans transporter
les headers, payloads ou secrets de configuration des générateurs.

Une comparaison avec des logs récepteur peut être attachée une seule fois par
`POST /api/runs/:runId/fleet-receipts` (administrateur). Le corps contient
`confirmed: true`, l'`origin` HTTP de la cible et des `records` bornés comprenant
`trace`, `source`, `status`, `epochSec`. La trace doit correspondre exactement au
campaignId/runId/agentId/attemptId ; la réception doit tomber dans la fenêtre de
génération, avec une tolérance d'horloge de deux secondes. La comparaison est
persistée et auditée atomiquement ; elle conserve les écarts, les sources réseau
et le SHA-256 des records normalisés. Il s'agit de logs importés attestés par
l'opérateur, pas d'une authentification indépendante de leur origine par l'app.
L'absence de logs reste explicite et ne devient jamais une mesure à zéro.

Sur la cible dédiée `46.28.109.92`, un journal nginx séparé ne capture que les
requêtes portant une trace Fleet complète. Il ne contient ni cookies ni headers
d'authentification ; son fichier reste privé sur l'hôte. Son activation est une
modification d'observabilité validée par `nginx -t`, sans changement de ports,
de firewall ou des endpoints de benchmark. La collecte/import reste opérateur ;
un collecteur automatique authentifié pourra être raccordé ultérieurement.

### Livraison vérifiée — build 457

Le build 457 (`72f8b2a69860`) est déployé, API et assets vérifiés. Les comptes,
mots de passe, rôles, versions de session et fiches d'inventaire sont inchangés.
Les trois bots conservent leurs Pod UIDs et IPs privées ; aucun nouveau bot ni Job
n'a été créé par cette livraison. Les deux lots couvrent mesures/rapport et
cohérence du parcours Fleet, campagnes, Run Theater, Command Center et templates.

| Recette navigateur                              | Campagne                               | Résultats                                                                                                  |
| ----------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sélection de deux appareils depuis Fleet        | `cc0833d4-7944-4d0f-8602-74f39e3bba25` | lab-iot-01 et lab-iot-03 SUCCEEDED ; 49 réponses 2xx, zéro erreur ; sonde 4/4 ; 49 reçus cible concordants |
| Parcours depuis le template Fleet, arrêt global | `de022812-5a17-46e4-959c-972bdb31abb2` | trois STOPPED ; 19 réponses 2xx, zéro erreur ; sonde 2/2 ; 19 reçus cible concordants                      |

Les deux campagnes utilisent `http://46.28.109.92/`, un budget global de 3 RPS et
une enveloppe de 20 secondes. Les runs sont respectivement
`30a681b8-bdd2-4e7f-bcbc-c063d2a6931c` et `aca58407-0e77-4b0e-a14b-109d0157b90c`.
Les 68 reçus serveur ont pour source `31.31.74.187` : il s'agit bien de l'egress
commun des bots, distinct du VPS applicatif de la sonde. Les IDs et tentatives
figurant dans les traces relient chaque reçu à son agent. Les rapports HTML,
exports JSON et panneaux de résultat affichent les rapprochements persistés.
Une deuxième importation est refusée (409) ; les reçus existants restent immuables.
Le statut de capacité demeure INCONCLUSIVE et les timings de protection estimés :
un rapprochement de compteurs ne certifie pas la résistance de la cible.

Validation : 1 135 tests backend, 418 frontend, 42 tests PostgreSQL et restauration
chiffrée, typecheck, lint, builds local/natif et recette navigateur de production.
Les captures ont été inspectées. Les preuves privées sont conservées hors dépôt
dans `2026-10-14-fleet-lots-live-01` ; les sessions temporaires sont supprimées et
aucune campagne ne reste RUNNING. Les scripts opérateur de journalisation et de
collecte sont `scripts/operations/install-fleet-receiver-log.py` et
`scripts/operations/collect-fleet-receipts.py` ; leur sortie se destine au contrat
d'import ci-dessus. Ils n'exécutent aucune génération de trafic.

Les profils métier POST, les suites Fleet, la collecte automatique authentifiée,
le provisioning, la rotation automatique et Kusa restent hors de ces deux lots.
Le développement autonome s'arrête à cette livraison et attend une reprise explicite.

## Premier parcours de campagne intégrée

Avec `FLEET_MISSIONS_ENABLED=1`, le moteur de campagne `fleet` utilise les trois
agents déjà enrôlés du groupe `VPS Lab`, sans créer de Jobs supplémentaires.
Fleet propose « Create Fleet campaign » : reconnaissance de la cible, configuration
GET, confirmation habituelle, suivi dans Run Theater et arrêt commun par « Kill ».
Le panneau du Theater est filtré par campagne ; il conserve les reçus STOPPED
et les états LOST après la fin du run. Le résultat agrégé contient les preuves
Fleet et rejoint la persistance et le rapport habituels de la campagne.

Le premier incrément prend une seule URL GET, 3–15 RPS au total, 3–6 workers et
10–60 secondes. Les trois agents doivent être présents. Il reprend la `target`
et la `probeUrl` validées par la campagne, sans fabriquer de chemin `/health`.
Une origine doit satisfaire l'allowlist applicative courante,
`FLEET_CAMPAIGN_ORIGINS`, la politique indépendante des workers et les règles
réseau du laboratoire. Une clé de bot ne peut créer ni arrêter une campagne.
La session opérateur et sa date d'expiration sont conservées pour fermer les baux
si cette session cesse d'être valide. Les missions historiques partagent le même
verrou de budget : aucun chevauchement silencieux avec une campagne.

Pour une cible externe, la sonde locale de campagne part du VPS applicatif,
distinct du VPS des agents. Les trois bots ont des IP privées différentes mais
partagent l'IP publique du VPS lab. Les anciennes mesures de protection classe C
ne sont pas reprises comme temps mesurés de cette campagne ; les timings restent
explicitement estimés tant qu'un connecteur corrélé au run n'est pas intégré.
Les profils métier POST, les mélanges d'endpoints et les suites Fleet ne sont pas
livrés par cet incrément. Le contrat IoT v2 préparé localement n'est pas utilisé
par les workers actuels.

### Livraison de ce parcours : build 456

Source applicative déployée : `7b16410ba980`, manifeste API et UI vérifié.
La recette navigateur a utilisé Fleet → Create Fleet campaign → reconnaissance
de `http://46.28.109.92/` → Configure Fleet campaign → création → confirmation
Run now → Run Theater. Le groupe conserve les mêmes trois fiches, Pod UIDs et IPs
privées ; un redémarrage de conteneur a chargé la politique autorisant l'origine
HTTP approuvée et l'egress `46.28.109.92/32` sur TCP 80.

| Recette                                 | Campagne                               | Résultat                                                                                         |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET, 3 RPS partagés, enveloppe 20 s     | `5a3a54cb-aa50-43ff-992d-ef667f2d200a` | COMPLETED ; trois SUCCEEDED ; 50 réponses 2xx, zéro erreur ; sonde 4/4                           |
| Même enveloppe, arrêt depuis le Theater | `d7e0e1fe-221a-4444-be1f-e0a1f1296a8c` | KILLED_MANUAL ; trois STOPPED ; 20 réponses 2xx ; une AbortError liée à l'annulation ; sonde 2/2 |

Les résultats persistés sont respectivement `7c2a25ce-123b-4ad6-93a0-08aed2d630ab`
et `b2d216e9-a737-41cd-8f9b-72e0fa878231`. Les captures du Theater confirment les
trois états finaux après navigation et relecture. Les compteurs sont ceux des
agents et des réponses reçues ; les logs serveur de la cible externe n'ont pas
été collectés. Le rapport normal conserve un verdict INCONCLUSIVE du fait d'une
contention CPU détectée dans les cgroups agents. Le WRS est estimé : cette recette
valide le parcours fonctionnel, pas la capacité ou la protection de la cible.
L'AbortError de la recette arrêtée n'est pas effacée des compteurs.

Validation : 1 130 tests backend, 416 frontend, 42 tests PostgreSQL avec
restauration chiffrée, typecheck, lint, builds local et natif et recette réelle
du navigateur de production. Les comptes et leurs versions de session sont
inchangés ; aucune campagne ne reste RUNNING après la livraison. Les preuves
privées sont conservées hors dépôt dans `2026-10-14-fleet-campaigns-live-01`.
Le développement autonome s'arrête après cet incrément ; les profils POST et
la refonte des autres pages attendent une nouvelle instruction.

Le parcours Fleet ajoute la sélection des agents déjà enregistrés, un lancement
confirmé, le suivi des compteurs et une commande d'arrêt. Il réutilise
`FleetCoordinator` et `runFleetAssignment`, sans créer une deuxième flotte de Jobs.

## Contrat et fonctionnement des missions historiques du build 455

- Le contrôleur nécessite PostgreSQL, une session administrateur active et
  `USER_MODE=single`. Activation explicite : `FLEET_MISSIONS_ENABLED=1`.
- La cible de cette première version est exclusivement `http://lab-target:8080/`,
  dans le namespace privé du laboratoire. Le trafic est HTTP GET.
- Le plafond partagé est 15 requêtes/s, 6 connexions et 60 secondes, réduit par
  les limites opérationnelles de l'application. Une recette utilise 3 requêtes/s
  au total, une connexion par agent et 20 secondes.
- Chaque agent réclame sa commande une seule fois avec sa clé d'enrôlement,
  distincte d'une session utilisateur. Son identité est vérifiée côté serveur.
- Les agents renouvellent leur bail toutes les 2 secondes. Le bail expire au bout
  de 6 secondes au maximum ; l'arrêt et la perte de contrôle ferment la génération.
- Un redémarrage du contrôleur ne relance aucune ancienne mission. Un budget
  reste réservé jusqu'à son échéance et sa marge de fermeture, même après arrêt.
- Une révocation de clé, de session administrateur, une réduction des limites ou
  un arrêt global cessent les renouvellements. Les demandes opérateur sont auditées.
- Les résultats sont persistés dans PostgreSQL. `STOPPING` est une demande ;
  `STOPPED` est l'état remonté par l'agent ; `LOST` signifie une issue inconnue.

L'interface **Fleet → Fleet missions** sélectionne jusqu'à trois agents marqués
`fleet-mission-agent/v1`. Les anciens clients de présence restent compatibles.
La clé agent ne permet ni de créer une mission, ni de gérer des utilisateurs.

## Réseau et exploitation

Les trois pods ont des IP privées différentes. Les NetworkPolicies autorisent
uniquement DNS, le contrôle HTTPS/mTLS et la cible dédiée sur TCP 8080. L'adresse
publique commune n'empêche pas trois clients HTTP indépendants. Le traceur
`X-WEDOS-TEST` identifie chaque mission, agent et tentative à la réception.
Il ne simule pas trois IP publiques.

Les pods remplacés conservent leurs trois fiches d'inventaire et reçoivent des
clés renouvelées. Leur redémarrage quotidien conserve la séquence de présence
sur le volume du pod. Un nouveau pod avec une nouvelle IP exige une réconciliation
et un réenrôlement explicites. Les certificats et clés d'application ont toujours
une expiration ; leur renouvellement automatique reste à implémenter.

## Recette et limites

La recette opérateur `scripts/operations/fleet-mission-recipe.mjs` lance une mission
normale puis une mission arrêtée manuellement sur la cible privée. Elle échoue si
les trois résultats attendus ne sont pas acquittés ou comportent des erreurs HTTP.
Les mesures de réception de la cible et les échantillons d'une sonde indépendante
complètent ces compteurs ; aucun WRS n'est déduit de cette recette fonctionnelle.

Cette version ne prend pas une URL publique libre, ne fabrique pas d'IP source et
ne raccorde pas encore Kusa. Les profils sensor/camera/gateway restent les profils
d'inventaire ; leurs messages métier POST ne sont pas implémentés par cette mission
GET. Le provisionnement Kubernetes et le renouvellement des certificats restent
opérateurs. L'orchestration utilisateur livrée porte sur lancer, suivre et arrêter
les missions des trois agents déjà provisionnés.

## Résultats livrés le 14 octobre 2026

Production : build **455**, source applicative `ec038f70ce7a`, API et assets vérifiés.
Les 11 comptes, mots de passe, rôles et versions de session sont préservés. Les
identités des trois fiches Fleet sont conservées après remplacement des pods.

| Recette                                           | Mission                                | Résultat reçu par la cible                    |
| ------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| Exécution normale, 3 req/s au total, 20 s maximum | `0fdb409c-a750-45c1-9020-0b7470be9b9a` | 51 réponses HTTP 200 ; trois agents SUCCEEDED |
| Arrêt demandé pendant une mission de 30 s maximum | `0fe74ee2-8208-4e78-a5cd-44f72c37f1f8` | 21 réponses HTTP 200 ; trois agents STOPPED   |

Les requêtes reçues correspondent exactement aux compteurs par agent et proviennent
de `10.247.0.71`, `.72` et `.73`. Deux validations navigateur supplémentaires ont
exercé les boutons de lancement et d'arrêt ; chacune confirme trois états STOPPED.

La sonde a un premier jeu de 90 mesures, dont une indisponible à son démarrage.
Un second contrôle conserve une phase d'initialisation explicite, puis obtient
30/30 HTTP 200 pendant une commande utilisateur. Le script reproductible est
`scripts/fleet/lab-probe-samples.mjs`, à exécuter dans le pod de sonde indépendant.
L'échantillon indisponible initial est conservé ; aucun score WRS n'est produit.

La cible utilise le ConfigMap `lab-target-web-readable-20261014-01`, monté en lecture
seule pour rendre les fichiers du benchmark accessibles au processus non root.
La correction de propriétaire et de modes est également dans son Dockerfile.
Les reçus et captures sont conservés dans le répertoire privé d'évidence
`2026-10-14-fleet-missions-live-01`, hors du dépôt ; aucun secret n'est publié.

Validation : 1 126 tests backend, 415 frontend, 41 tests PostgreSQL et contrôle de
restauration ; deux tests navigateur d'inventaire/enrôlement ; compilation et tests
ciblés natifs sur le VPS, puis recette de l'interface de production avec mTLS.

## Refonte DRS du 14 octobre 2026

Les 281 campagnes historiques ont été archivées (183 nouvelles archives, 98 déjà archivées), sans suppression des campagnes, résultats ou audits. Aucun lancement n'a accompagné cette opération.

Le serveur démarre par défaut avec `CAMPAIGN_CATALOG=drs-fleet`. Le catalogue expose uniquement les douze profils L7 référencés dans le dépôt comme DRS v3 / P26-20371. Le document original n'a pas été vérifié indépendamment : ce catalogue ne constitue pas une certification DRS. Seul le profil GET borné est configurable ; les onze autres sont désactivés et ne sont jamais remplacés par un générateur local. Les anciennes voies de création de modèles et de suites sont refusées dans ce mode.

La capacité du registre est de 5 000 appareils répartis sur 100 sites. La pagination, les limites, la persistance PostgreSQL et les recherches authentifiées par identifiant ont été testées. Cela ne démontre ni 5 000 agents connectés ni leur exécution simultanée. Les limites d'exécution restent à **3 agents, 15 requêtes/s, concurrence 6 et durée 60 secondes**. Aucun cluster infrastructure ni adaptateur Kusa n'a été déployé.

Chaque appareil possède un identifiant global et un `siteId`. Les IP privées doivent être distinctes dans un site ; des réseaux privés de sites différents peuvent se recouvrir. Une modification du site ou de l'IP révoque l'enrôlement. La sélection de campagne conserve les identifiants explicites entre les pages et n'effectue aucun remplacement silencieux. Les mesures conservent le site déclaré lors du lancement.

Les erreurs internes de lancement renvoient une référence de diagnostic, également conservée dans la campagne ; les détails privés restent dans les journaux serveur. Les campagnes archivées ne peuvent plus être exécutées. Les autorisations de cible, budgets, sonde indépendante et mécanismes d'arrêt existants restent obligatoires.

Validation locale : typecheck et build, 1 142 tests backend réussis (31 conditionnels ignorés), 426 tests frontend réussis, 43 tests PostgreSQL et restauration chiffrée réussis. Recette visuelle isolée avec 5 000 entrées fictives et 100 sites ; aucune campagne créée ou exécutée pendant cette recette. Les travaux locaux préexistants sont préservés.

À poursuivre : vérification du standard original, intégration infrastructure/Kusa et qualification de capacité. L'inventaire multisite seul n'offre pas un provisionnement Kubernetes ni une preuve de capacité sous charge.

## Versioned DRS plans and evidence

Reference data live in `standards/drs/3.00.00/`. The original PDF, author and GFDL-1.3 license remain archived; catalogue JSON files preserve source identifiers as strings, sections/pages, per-line source text, requirements and conflicts. Do not alter this directory after release; a source or interpretation change requires a new version/profile. The startup integrity check validates every archived file. The importer `scripts/drs/import-catalogue.py` is deterministic and requires Python pdfplumber plus the repository Prettier tool; it is an offline reference-import operation, not an execution command.

Three modes are explicit: `engine-validation` produces simulation-only results; `synthetic-lab` produces experimental results limited to reproduced dimensions; `measured` evaluates imported independent evidence and cannot dispatch until physical instrumentation and capacity are qualified. No mode is certification. A 200 HTTP response cannot alone establish a working login, API journey or usable challenge.

The plan snapshots the standard version, catalogue hash, scoring-engine version and interpretation profile. It declares services, URLs/protocols/journeys, functional assertions and success tolerances, architecture and injection location, four measurement roles, sampling and clock uncertainty, baseline/exposure/recovery windows, shared execution budgets, stop conditions and protection/component versions. Probes must declare separate resources and connection pools from generators. Source exclusions retain the full denominator and are reported as partial coverage. Any modification creates a new revision; old revisions, reports and failed attempts remain readable.

The state machine is `DRAFT → PLAN_FROZEN → CAPACITY_CHECK → BASELINE → LEVEL_EXECUTION → RECOVERY → EVIDENCE_VALIDATION → LEVEL_CALCULATION → next level or FINAL_REPORT`. Event simulation uses a virtual clock, not five minutes of real waiting. Physical observation uses bounded deadlines and always stops injection before recovery. An unconfirmed stop or incomplete instrumentation cannot authorize a next level. The evidence API archives independently collected observations; it does not send traffic.

Each attempt archives timestamps, requested load, independently sourced generator/entry/user/origin observations and artifact hashes, functional baseline and under-load transaction counts, full bounded latency samples with recomputed mean/percentiles, outage and recovery, manual interventions, gaps, injection location, physical/virtual counts, observed addresses, emulated/missing dimensions, calibration and joint-exposure identity. Unit-bearing load counters are used as recorded. A synthetic multiplier is never part of scoring. Evidence imported by a CISO remains labelled `collector-import`: structural validation and archive hashing do not claim physical attestation by the server.

Validity (`VALID`, `INVALID`, `INCONCLUSIVE`) is separate from outcome (`PASS`, `FAIL`, `NOT_EVALUATED`). Missing/unstable baseline, saturation, telemetry gaps, unknown received load, missing functional assertions, unsupported units, absent recovery and unresolved verdict-affecting source ambiguities cannot become PASS. A broken functional assertion with measured transactions is FAIL. Source diversity/persistence are conservatively required for complete positive coverage; these are profile interpretations and are not substituted with virtual clients or a short synthetic run.

Scoring retains the complete level denominator. It compares integer cross-products, without prior rounding: ratios strictly greater than 75% at levels 1–3 or 85% at levels 4–7 PASS; strictly below 40% FAIL; equal boundaries are MET under the documented conservative interpretation. A terminal MET retains its level score; FAIL uses the last passed level, or null if none exists. The plan's maximum level terminates the process. Unknown scenarios or unsupported exclusions make coverage partial; no full score is invented. Additional attempts beyond the terminal level are diagnostic. A valid failure in an earlier attempt is retained even if a retry passes. New configurations require a new revision rather than overwriting failures.

Authenticated API:

- `POST /api/drs/validations`: standalone offline validation, create capability; fictional scope, no target attestation or Fleet enrollment. Physical dispatch remains impossible. Finalization marks the software campaign completed without granting physical approval.
- `GET /api/drs/reference`: immutable catalogue, levels, types, scoring and ambiguities.
- `GET /api/campaigns/:id/drs`: revisions and default plan.
- `POST /api/campaigns/:id/drs/revisions`: new draft revision (`plan`), create capability.
- `POST .../freeze`: freeze current plan, approval capability.
- `POST .../capacity`: record current capacity qualification status, create capability.
- `POST .../simulate`: explicitly confirmed engine validation fixture, execute capability; no physical ports.
- `POST .../evidence`: append independent collector evidence, approval capability.
- `POST .../attachments`: archive existing `runId` or completed isolated `benchRunId`, approval capability; diagnostic only, same campaign target required for run attachments.
- `POST .../finalize`: always finalize an integrity-checked report, approval capability.
- `GET .../report.json?revision=N` and `.../report.html?revision=N`: reproducible archived results, read capability; HTML escapes evidence and has a restrictive CSP.

Mutations except revision creation require `revisionId` to reject stale clients. Archived campaigns are read-only; physical running campaigns refuse concurrent evidence mutations. Writes and audit receipts are transactional in memory and PostgreSQL. Evidence envelopes are centralized in config/limits.ts (32 revisions, 512 attempts/revision, 2,048 distribution samples, 1 MiB request envelope and 8 MiB campaign archive). These are storage limits, not generator budgets.

Independent entry/origin endpoints and real functional/calibration collectors need to be bound to the declared instrumentation before an evaluation can establish those dimensions. The default capacity response explicitly says physical execution is not qualified; the lab profile does not silently substitute other generators or create public reflectors.

### Livraison vérifiée — build 463

Déployée le 14 octobre 2026 à partir de la source `bbd4293fb91e57abda167478b44ab7d9ade4f07f39f730d68e98c17c4799ed2e`. Vérifications : typecheck/build/lint, suite globale locale de 1 178 tests backend et 428 tests frontend réussis, puis contrôle final ciblé de 56 tests backend pour les dernières garanties d'isolation ; 44 tests PostgreSQL et restauration chiffrée réussis ; gate native VPS de 164 tests backend et 77 tests frontend réussis. Recette locale visuelle complète, catalogue paginé, mobile sans débordement et rapport HTML vérifiés.

L'API et les assets de production correspondent à la source livrée. Les 11 comptes, l'administrateur unique et les trois appareils sont conservés. Les 282 campagnes existantes sont préservées, dont les 281 archives et le brouillon Fleet précédent. Une nouvelle campagne de validation logicielle `ff87194b-5e50-4b32-b148-4881ba3f83ef` est terminée, sans cible réelle, sans attestation de cible et sans générateur : score de simulation 1, recalculé à l'identique depuis les preuves archivées. Aucun trafic de campagne physique émis. La session de vérification temporaire a été supprimée ; la version précédente reste disponible pour rollback.

Le catalogue vérifié contient 37 définitions de types et 131 lignes par niveau, avec 140 anomalies ou choix d'interprétation tracés. Les ambiguïtés non résolues restent visibles et peuvent empêcher un score exploitable. Les collecteurs d'entrée/origine, les parcours fonctionnels et la capacité réelle restent à qualifier/raccorder ; le mode mesuré ne prétend pas qu'ils sont présents. Le reste de la roadmap générale n'a pas été repris.
