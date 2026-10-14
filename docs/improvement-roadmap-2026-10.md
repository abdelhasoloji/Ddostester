# Roadmap d’amélioration de Ddostester — octobre 2026

Date : 13 octobre 2026. Référence déployée : build **451**, snapshot `d98db08+audit.c5392dde4e66`. Cette feuille de route détaille les travaux futurs de la [roadmap de statut](./roadmap.md), à laquelle elle reste rattachée. Les estimations sont des charges de développement et de validation, pas des dates promises.

## 1. Point de départ et résultat recherché

Transformer le contrôle plane actuel en laboratoire de résilience HTTP reproductible : comptes et permissions cohérents, agents IoT **simulés** sur IP privées distinctes, cible dédiée, sonde indépendante, mesures traçables, intégration Kusa gouvernée. Le raccordement au cluster infrastructure vient après la preuve des garanties du laboratoire.

Éléments déjà livrés et vérifiés dans la [release 451](./audit-release-2026-10-13.md) : propriétaire admin unique `abdelha@wedos`, profils gérés, révocation des sessions, corrections A01–A12, validation des destinations avant I/O, redirections désactivées, arrêt borné des processus, audit transactionnel, verrou PostgreSQL de runtime, budgets login/assistant, liens de lecture sans JWT de session, promotion vérifiée API/UI et dashboards corrigés. Les 11 comptes et leurs mots de passe sont conservés. 1 338 tests ont passé ; les contrôles réels PostgreSQL et navigateur complètent cette validation.

Ces résultats ne certifient pas les vrais binaires des six moteurs, la fiabilité d’une flotte distribuée, les interfaces réelles de Kusa, la restauration après sinistre ou l’isolation Kubernetes. Aucun cluster de ce laboratoire ni agent de sonde distant n’est actuellement configuré. La chaîne d’audit n’a pas encore de témoin externe opérationnel.

Sources internes : [audit initial](./application-audit-2026-10-13.md), [correctifs](./application-audit-fixes-2026-10-13.md), [gestion des accès](./user-management-audit.md), [laboratoire Kubernetes](./kubernetes-iot-lab.md), `backend/src/`, `frontend/src/`, `.github/workflows/ci.yml` et `backend/test/store-contract.test.ts`.

## 2. Priorités et jalons

P0 : consolider l’installation actuelle. P1 : condition nécessaire au laboratoire distribué. P2 : améliorer la qualité et l’exploitation. P3 : extension après preuve d’utilité. Les portes G0–G4 sont des critères de passage, distincts de la priorité.

| Lot | Priorité | Livrable                                                  | Charge indicative | Dépendances             | Porte de sortie |
| --- | -------- | --------------------------------------------------------- | ----------------- | ----------------------- | --------------- |
| R01 | P0       | Sources, statut et release reproductibles                 | 2–3 j             | Build 451               | G0              |
| R02 | P0       | CI PostgreSQL et parcours d’accès complets                | 4–6 j             | R01                     | G0              |
| R03 | P0       | Sauvegarde/restauration, monitoring et témoin d’audit     | 4–6 j             | R01                     | G0              |
| R04 | P1       | Sonde distante et contrat de mesure fiable                | 5–8 j             | R02                     | G1              |
| R05 | P1       | Images et laboratoire Kubernetes isolé                    | 5–8 j             | R01, R02                | G1              |
| R06 | P1       | Contrat flotte et agent minimal autonome                  | 5–8 j             | R02, R05                | G2              |
| R07 | P1       | Coordination durable, budgets et arrêt distribué          | 8–12 j            | R06                     | G2              |
| R08 | P1       | Agrégation, preuves cible et rapports de flotte           | 5–8 j             | R04, R07                | G3              |
| R09 | P2       | UX d’exploitation, conformité des moteurs, assistant/Kusa | 7–11 j            | R02, R08 pour la flotte | G3              |
| R10 | P1       | Recette VPS et dossier de raccordement infrastructure     | 4–6 j             | R03–R09                 | G4              |

Total indicatif : **49–76 jours-personne**, hors attente infrastructure, acquisition de matériel et interfaces externes indisponibles. Prévoir une marge de 20–30 % après le spike R06/R07. Avec un développeur principal, raisonner en environ 12–20 semaines calendaires de travail disponible ; réestimer à chaque porte. L’UX et certaines tâches d’exploitation peuvent avancer en parallèle, mais les garanties de budget et d’arrêt conditionnent la mesure distribuée.

## 3. Travaux détaillés

### R01 — Référence produit et livraison reproductible

**Constat.** Le dépôt contient des travaux locaux non committés ; la release actuelle provient d’un snapshot validé. Certaines formulations historiques annoncent une preuve signée ou une attribution à l’edge que le produit ne peut pas encore établir. Le document Kubernetes décrit aussi une ancienne politique de rôles.

**Travaux.** Inventorier les changements avec leur propriétaire avant regroupement en commits/PR cohérents. Associer chaque release à un commit, un manifeste d’assets, un lock et un bilan de recette. Séparer état « implémenté », « testé avec fixtures », « vérifié sur VPS » et « dépendance externe ». Réconcilier roadmap, opérations, architecture et contrats d’accès. Corriger notamment « audit chaîné » versus « preuve signée », succès HTTP versus attribution, Node ≥22.19 et politique admin/team/single. Documenter une promotion d’image Compose/Kubernetes explicite avant d’offrir ce parcours.

**Validation.** Une release reconstruite depuis ses sources identifiées passe le gate existant ; une mauvaise build API, un asset UI divergent ou un checkout modifié empêche la promotion. Aucun travail local n’est supprimé. Les résultats historiques restent datés et ne sont pas présentés comme une recette nouvelle.

**Sources.** `deploy/update.sh`, `scripts/{release-manifest,verify-release,account-preflight}.mjs`, `docs/roadmap.md`, `docs/kubernetes-iot-lab.md`.

### R02 — Accès, sessions et persistance vérifiés en continu

**Constat.** Les transactions et leases ont été vérifiés sur le VPS, mais la CI générale n’active pas le contrat PostgreSQL via `DATABASE_URL_TEST`. Le gate de release ne doit pas dépendre uniquement du store mémoire.

**Travaux.** Ajouter une base PostgreSQL de test éphémère et les suites de contrat, audit, verrou et concurrence. Tester le propriétaire unique sous mutations concurrentes, révocation effective sur API/rapports/SSE, changement de profil, reset temporaire et accès viewer/engineer/ciso. Ajouter un parcours navigateur admin de gestion des comptes avec serveur et base de recette. Définir une procédure de récupération du propriétaire, d’abord administrative et auditée ; transfert éventuel ultérieur, sans créer durablement un second admin. Examiner le transport et la durée des tokens d’écriture dans le navigateur, puis choisir explicitement entre bearer court et session cookie complète avec protection CSRF ; le cookie de lecture actuel ne devient pas une autorisation d’écriture.

**Validation.** Suites PostgreSQL obligatoires dans la CI concernée, sans skip silencieux ; échec DB => mutation et audit annulés ; second contrôle plane refusé ; profil révoqué immédiatement refusé ; aucun reset collectif de mots de passe. La récupération est répétée sur une copie de recette et laisse une trace exploitable.

**Sources.** `backend/test/store-contract.test.ts`, `backend/src/store/{postgres,audited}.ts`, `backend/src/auth/`, `backend/src/modules/users/service.ts`, `frontend/src/{api,context,settings-cards}.tsx`, `.github/workflows/ci.yml`.

### R03 — Exploitation, récupération et témoin indépendant

**Travaux.** Automatiser sauvegardes chiffrées, rétention, contrôle d’intégrité et restauration sur base séparée. Fixer comme objectifs initiaux à négocier RPO ≤24 h et RTO ≤2 h. Documenter redémarrage, saturation disque, panne DB, expiration de certificats et tunnel monitoring interrompu. Ajouter alertes de santé : absence de scrape, event-loop lag, erreurs DB/audit, hard-stop, saturation des files et stockage. Contrôler les dashboards via le stockage/API actuel de Grafana et vérifier la compatibilité des séries à chaque livraison. Envoyer les checkpoints d’audit vers un collecteur indépendant avec credentials limités, continuité, alerte d’absence et rétention dédiée ; la signature éventuelle requiert une clé distincte et sa rotation.

**Validation.** Restaurer une sauvegarde dans un environnement séparé et vérifier comptes, historique et chaîne d’audit. Une coupure de collecte déclenche une alerte. Une tête tronquée ou une discontinuité de checkpoints est détectée. Aucun secret n’apparaît dans logs ou exports. Le collecteur ne doit pas dépendre uniquement de la même base et des mêmes droits administrateur que l’application.

**Sources.** `scripts/audit-checkpoint.mjs`, `backend/src/modules/audit/`, `deploy/monitoring/`, `docs/operations.md`, `docs/observability.md`.

### R04 — Sonde indépendante et qualité de mesure

**Constat.** L’arrêt automatique et le WRS utilisent désormais la sonde brute. La sonde distante existe dans le dépôt mais n’est pas configurée sur l’installation ; baseline et mesure sous charge doivent partager le même point d’observation.

**Travaux.** Conteneuriser la sonde existante ; identité séparée, budget réservé et limites propres. Utiliser la même sonde pour baseline, phases et récupération. Formaliser versions de schéma, unités, fenêtres, freshness, taux d’échantillonnage, délais et provenance. Mesurer CPU, throttling et event-loop de la sonde pour distinguer contention locale et indisponibilité cible. Une absence ou une divergence rend le rapport incomplet/inconclusif. Garder les politiques historiques versionnées ; ne pas recalculer silencieusement les anciens scores.

**Validation.** Fixtures avec succès du générateur et sonde indisponible, sonde muette, forte latence, données périmées, horloge décalée et saturation locale. Aucun succès générateur ne neutralise l’arrêt. Les rapports séparent observation, estimation et attribution corroborée. Le WRS ne change pas de formule sans version, corpus de référence et justification.

**Sources.** `deploy/probe-agent/`, `backend/src/modules/{probe,campaigns/baseline,campaigns/recovery,reports,wrs}/`.

### R05 — Socle Kubernetes isolé et reproductible

**Choix.** Mac : kind avec runtime Docker et Calico ; VPS de laboratoire dédié : K3s mono-nœud. Réutiliser Kustomize pour base et overlays ; garder un seul replica Ddostester et une base de recette distincte de la production. Kind permet de remplacer son CNI et recommande l’API en loopback ; un CNI qui applique effectivement NetworkPolicy est indispensable. Voir [configuration kind](https://kind.sigs.k8s.io/docs/user/configuration/) et [NetworkPolicy Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/). Les prérequis K3s doivent être vérifiés avant provisioning : [exigences K3s](https://docs.k3s.io/installation/requirements).

**Travaux.** Images arm64/amd64 avec versions/digests identifiés : contrôle plane, agent builtin HTTP, sonde et cible nginx/PHP-FPM dédiée. PostgreSQL, Prometheus et Grafana isolés. Namespaces et comptes de service limités, Secrets référencés, non-root, capabilities retirées, filesystem en lecture seule lorsque possible, quotas, requests/limits et PVC. Refus réseau par défaut puis autorisations minimales cible/sonde/DB/collecte/DNS ; accès UI par port-forward loopback. Vérifier les CIDR face au LAN et au VPN. NetworkPolicy standard filtre les flux L3/L4 et n’est pas une allowlist de noms DNS : compléter par contrôle applicatif et, si nécessaire, capacités explicites du CNI/résolveur.

**Validation.** Manifests rendus et validés, identités/RBAC minimaux, aucune exposition publique, trois agents privés et une quatrième source sonde observés directement par la cible. Tester les refus réseau avec fixtures contrôlées et inspection des règles ; ne pas sonder des services publics ou métadonnées réels. Vérifier que le CNI applique les politiques, pas seulement que les objets existent.

**Limite.** Pods distincts partagent encore l’hôte ; CPU limits ne constituent pas un cap RPS. Mac et VPS se comparent fonctionnellement, pas comme classement absolu de performance.

### R06 — Contrat de flotte et autonomie des agents

**Travaux.** Définir les schémas `assignment`, `heartbeat`, `result`, `stop` et leurs versions, erreurs et compatibilité. Conserver `campaignId`, `runId`, `agentId`, `attemptId`, hash de configuration et séquences monotones. Associer chaque mission à une identité, une cible autorisée, des ports, un budget par phase, une deadline et un bail court. Les agents revalident ces contraintes ; aucun shell, image ou URL arbitraire n’est accepté depuis l’assistant. Préparer mTLS et rotation/révocation des identités d’agents. Implémenter d’abord l’agent builtin HTTP ; présenter clairement les moteurs indisponibles, sans repli silencieux.

**Validation.** Schéma invalide, identité inconnue, message ancien, replay, mauvais run et deadline dépassée refusés. Perte de contrôle => arrêt autonome sans nouvelle génération automatique. Les tests de contrat précèdent l’intégration Kubernetes. Le renouvellement de certificat ne permet pas de récupérer un budget périmé.

**Sources.** Contrat proposé dans `docs/kubernetes-iot-lab.md`, `backend/src/agents/{types,builtin}.ts`, `backend/src/engine/loadTest.ts`, nouveaux modules flotte à créer.

### R07 — Coordination durable et arrêt distribué

**Constat.** Le lease PostgreSQL actuel empêche deux contrôle planes sur une base. Il ne distribue ni budgets, ni kill switches, ni suites. Une simple augmentation du nombre de replicas serait incorrecte.

**Travaux.** Persister run parent, shards, budgets, baux, tentatives et état d’arrêt en PostgreSQL. Claims atomiques, fencing des tentatives périmées et résultats idempotents. La somme des allocations RPS et concurrence reste sous le budget global ; sonde, baseline et récupération ont des enveloppes explicites. Définir la tolérance de burst et les fenêtres de mesure avant de certifier le respect des caps ; une moyenne finale ne suffit pas. Réconciliation au redémarrage : arrêter puis marquer incomplet si l’état est incertain, sans relancer la charge. Jobs avec deadline, absence de retry automatique et export avant nettoyage. Ne pas introduire Redis ou un bus supplémentaire tant que PostgreSQL répond au besoin du MVP.

**Validation.** Doubles claims, replay, partition réseau, crash coordinateur, agent perdu, révocation de cible et baisse de limites en cours de run. Ne réallouer un budget perdu qu’après expiration effective et marge de fermeture. Objectif de laboratoire à confirmer : aucune nouvelle requête au-delà de 8 s après arrêt/perte de contrôle, corroborée par logs cible et connexions en vol. État STOPPED complet seulement avec preuves d’arrêt ; sinon état explicite incomplet. Le scheduler reste désactivé dans le MVP.

### R08 — Agrégation et rapports fondés sur des preuves

**Travaux.** Définir buckets d’histogrammes communs et fenêtres alignées ; sommer les compteurs et fusionner les histogrammes, sans moyenne de p95. Séparer débit demandé, émis, réussi et reçu à la cible ; caractériser le sous-débit sans augmenter les caps. Brancher la télémétrie cible par un bridge JSON conforme au provider existant. Capturer manifestes, versions, limites, profil/graine, identités, IP privées, causes d’arrêt, échantillons absents et références d’artefacts. Dashboard flotte et rapport par agent avec qualité de mesure, récupération et comparaison de runs homogènes. Préparer une dépréciation documentée de `originRps`/`absorbedRatio` ; garder la lecture de l’historique.

**Validation.** Corpus connu de compteurs/histogrammes, événements dupliqués ou tardifs, shard absent, horloge décalée et télémétrie périmée. Aucune assimilation d’échec HTTP à une mitigation réussie. TTD/TTM restent estimés ou indisponibles sans événement réel de protection. Les exports HTML/CSV et séries Grafana sont cohérents avec la même provenance et la même politique de mesure.

**Sources.** `backend/src/modules/{metrics,target-telemetry,protection,reports,wrs}/`, `deploy/monitoring/grafana/dashboards/`.

### R09 — Expérience produit, moteurs et intégration Kusa

**UX.** Afficher capacités et politique actuelles depuis le serveur ; expliquer les refus de permission, cible, limite et état. Écran flotte : identité, version, santé, bail, budget, throttling et dernier message. Préflight lisible avant confirmation, arrêt visible, bilan de récupération et rapport inconclusif clairement distinct d’un bon résultat. Tester petits écrans, clavier, contraste, session expirée et reconnexion SSE. Compléter filtres comptes actifs/inactifs et explication des profils sans altérer l’invariant du seul admin.

**Moteurs.** Construire une matrice de conformité builtin/k6/Vegeta/Locust/JMeter/Gatling : versions, disponibilité, caps de concurrence, redirections, multi-phases, deadline, sortie et erreur. Exécuter les vrais binaires uniquement sur une cible dédiée isolée lors d’une recette ultérieure, à très faible budget. Les tests actuels de scripts/arguments ne prouvent pas cette conformité opérationnelle. Les profils IoT simulés sont des flows, think-time, payloads courts et graines reproductibles ; ils ne prétendent pas émuler un firmware ou un réseau géographique.

**Kusa.** Confirmer d’abord l’interface réelle, son authentification et le format des propositions ; commencer avec un stub. Lecture de résumés expurgés et propositions JSON versionnées, validées et montrées à l’opérateur. Utiliser les routes existantes pour toute mutation. En single, l’admin propriétaire suit la confirmation explicite ; en team, la politique de séparation des décisions reste applicable. La formulation historique du document lab « admin ne devient pas approbateur » doit être reconciliée avec ce contrat actuel. Aucun kubeconfig, secret, shell ni droit d’auto-approbation dans le contexte du modèle. Enrichir les quotas existants par un budget de tokens/coût, annulation, timeout et provenance des réponses. La puissance RunPod n’est pas requise pour l’orchestration du laboratoire.

**Validation.** Réponse LLM malformée, instruction injectée dans un rapport, proposition hors scope et indisponibilité du provider restent sans effet externe automatique. Permission revalidée au moment de l’action ; aucun contournement des caps par un outil. Un utilisateur peut examiner et rejeter une proposition. Ni token, ni coût total ne sont supposés mesurables avant confirmation du contrat provider.

### R10 — Recette Linux et raccordement infrastructure

**Travaux.** Rejouer le même corpus sur un VPS de laboratoire privé distinct des services existants. Vérifier persistance, arrêt autonome après coupure de contrôle, ressources, restauration, certificats et opérabilité. Produire dossier : manifests/digests, matrice de flux, RBAC, exigences CNI, stockage, règles de budget, preuve d’arrêt, rapport de mesure et runbooks. L’équipe infrastructure valide ensuite CIDR, SNAT, accès, quotas, IP publiques et séparation physique de sonde/cible si nécessaire.

**Validation.** Toutes les portes précédentes passent sur une release identifiée. Les logs de cible corroborent les sources privées et l’arrêt ; les limites sont respectées malgré les défaillances testées. Un refus de compatibilité cluster bloque le raccordement et reste documenté. Aucun résultat du laboratoire n’est présenté comme une certification DDoS Internet, IoT réel, haute disponibilité ou conformité réglementaire.

## 4. Portes de validation

| Porte                           | Preuve requise                                                                                              | Décision permise                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| G0 — installation consolidée    | CI PostgreSQL, release identifiable, restauration de recette, monitoring et audit exploitables              | Construire le lab local             |
| G1 — laboratoire isolé          | Réseau effectivement filtré, images identifiées, sonde indépendante, cible dédiée et IP privées corroborées | Intégrer des agents bornés          |
| G2 — contrôle distribué         | Caps agrégés, claims/fencing, arrêt autonome et acquittements testés sous panne                             | Mesurer la flotte                   |
| G3 — preuve produit             | Histogrammes/rapports fiables, provenance et inconclusif, contrat Kusa validé et gouverné                   | Rejouer la recette VPS              |
| G4 — candidature infrastructure | Recette Linux, restauration, runbooks et compatibilité validée par l’équipe                                 | Préparer le raccordement au cluster |

Chaque lot se termine par une PR relisible, les validations pertinentes, une mise à jour du statut et une procédure de retour arrière. Une absence de preuve reste « à valider ». La présente roadmap n’autorise et n’exécute aucun lancement, provisioning ou modification de compte.

## 5. Ressources, responsabilités et dépendances

| Ressource           | Proposition initiale                                                          | Responsable / décision                                                |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Développement       | Un développeur principal ; revue dédiée des invariants de caps, auth et audit | Produit/développement                                                 |
| Mac                 | VM Docker : environ 6 vCPU, 8–10 Go RAM, ≥20 Go disque disponible             | Vérifier le matériel réel avant installation                          |
| VPS lab             | Enveloppe estimée 4 vCPU, 8 Go RAM, 30 Go SSD ; quotas à mesurer              | Infrastructure et budget hébergeur                                    |
| Flotte MVP          | 3 agents, 1 sonde séparée, 1 cible dédiée ; commencer à 15 RPS globaux        | Limite de lab inférieure aux HARD_CAPS, aucune augmentation implicite |
| Persistance         | PostgreSQL séparé ; PVC initiaux 2 Go DB, 5 Go métriques, rétention courte    | Ajuster sur mesures et plan de sauvegarde                             |
| Collecte            | Prometheus/Grafana réutilisés en instance lab ; collecteur de témoin distinct | Infrastructure                                                        |
| Certificats/secrets | CA et identités agents, droits minimaux, rotation et révocation               | Infrastructure ; aucun matériel privé dans Git                        |
| Kusa                | Contrat API/auth, format des propositions, budget et données admissibles      | Propriétaire Kusa + développement                                     |

Ces capacités sont des estimations applicatives, pas les minima éditeur ni une réservation existante. Node ≥22.19 ; versions Kubernetes/CNI/K3s, images et moteurs à épingler après test de compatibilité. Aucun GPU, bus distribué ou produit Vault n’est indispensable au premier MVP. Les dépendances externes non inspectées (`shieldtest-lab`, interfaces Kusa, cluster équipe) conservent un statut non vérifié.

## 6. Backlog après le MVP

| Extension                           | Condition de déclenchement                                       | Limite à conserver                                                |
| ----------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Multi-replica/HA du contrôle plane  | Besoin de disponibilité documenté, coordination durable éprouvée | Le singleton actuel n’est pas supprimé sans remplacement testé    |
| SSO/MFA et fournisseur d’identité   | Usage équipe confirmé et recovery défini                         | Propriétaire unique et permissions serveur conservés              |
| Multi-tenant                        | Isolation de données et budgets réellement nécessaire            | Modèle par tenant, secrets et audit ; pas de simple filtre UI     |
| Builder de playbooks                | Corpus stable et UX du MVP validée                               | Chaque étape reste soumise aux approbations et budgets            |
| Évolution WRS/baseline              | Corpus de référence et sources protection corroborées            | Version de scoring, confiance et comparabilité explicites         |
| Déploiement automatique du SLO gate | Cible lab dédiée accessible depuis CI et règles validées         | Aucun déclenchement périodique sur cibles de production           |
| IP publiques / plusieurs sites      | Validation réseau et opérationnelle par infrastructure           | Aucun spoofing ; mesures privées distinctes des preuves publiques |
| Rapports conformité enrichis        | Revue du contenu et des preuves par responsables concernés       | Un export DORA/NIS2 ne constitue pas une certification            |

Écarter du contrôle plane les extensions d’amplification, spoofing et charge non bornée. Le modèle défensif séparé garde son propre dépôt et son contrat de verdict en lecture seule.

## 7. Premier sprint recommandé

Cible : **10 jours ouvrés**, ajustable au temps disponible. R01, socle R02 et première tranche R03 ; ne pas commencer par accroître la flotte.

1. J1–J2 : inventaire des travaux locaux, référence sources et mise à jour des statuts/politiques documentaires.
2. J3–J6 : PostgreSQL éphémère en CI, contrats transaction/lease/concurrence et parcours de révocation.
3. J7–J8 : restauration sur base isolée et runbook ; objectifs RPO/RTO confirmés.
4. J9–J10 : smoke navigateur sans campagne, contrôle API/UI et dashboards, revue des écarts restants.

Livrable de sprint : une installation reproductible avec preuves de persistance, récupération et accès, plus le backlog R04–R10 réestimé. Le collecteur d’audit externe peut demander une tranche supplémentaire si son hébergement n’est pas disponible ; ne pas annoncer G0 entièrement passé tant que ses preuves manquent.
