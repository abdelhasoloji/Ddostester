# Laboratoire Kubernetes IoT simulé et intégration Kusa

Date : 13 octobre 2026. Statut : proposition, aucune campagne ni aucun déploiement exécuté.

## 1. Périmètre et état du dépôt

Examen du checkout local `/Users/abdelhatayeb/lab/Ddostester`, remote `abdelhasoloji/Ddostester`, branche `main`, commit `d98db08` (suppression de l'écran Results, PR #215). Git indique `main...origin/main` sans divergence dans les références locales ; aucun fetch effectué, donc l'état distant actuel n'est pas certifié. Seul `.DS_Store` est non suivi au début de l'examen. Aucun fichier existant, secret, historique Git ou travail local n'est modifié.

Instructions lues : `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`. Aucun `AGENTS.md` trouvé dans les répertoires parents examinés ou dans les fichiers du dépôt. Le plan respecte la frontière du dépôt : HTTP borné sur cible autorisée, plafonds immuables, approbation, arrêt et audit. Les « bots » sont des clients IoT **simulés**, sans compromission, spoofing ni amplification. Le banc réseau classe C demeure séparé dans `shieldtest-lab` ; il n'est pas nécessaire pour ce laboratoire HTTP.

### Composants examinés et réutilisation

| Composant                 | Sources                                                                                                        | Réutilisation proposée                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campagnes et gouvernance  | `modules/campaigns/{model,service,runner,scheduler}.ts`, `app.ts`, `auth/rbac.ts`                              | Création, approbation distincte de l'auteur, exécution autorisée, arrêt, audit ; conserver l'API utilisateur                                               |
| Générateurs               | `agents/{types,index,builtin,k6,vegeta,locust,jmeter,gatling,proc}.ts`, `engine/{types,loadTest,slowloris}.ts` | Réutiliser les types et le moteur HTTP intégré dans un processus agent séparé ; nouvel adaptateur Kubernetes                                               |
| Plafonds                  | `config/limits.ts`                                                                                             | `HARD_CAPS` : 2000 RPS, 500 requêtes concurrentes, 900 s ; limites opérationnelles administrées par `admin` ; budgets distribués nécessairement inférieurs |
| Sondes                    | `modules/probe/probe.ts`, `modules/campaigns/baseline.ts`, `deploy/probe-agent/`                               | Service de sonde indépendant via `PROBE_AGENT_URL`/`PROBE_AGENT_TOKEN` ; harmoniser baseline et mesure sous charge                                         |
| Mesure et rapports        | `modules/target-telemetry/`, `modules/protection/`, `modules/wrs/`, `modules/reports/`, `modules/metrics/`     | Timeline, disponibilité, latences, assertions, WRS et rapports HTML/PDF/CSV ; ajouter provenance et détail par agent                                       |
| Stockage et observabilité | `store/{postgres,memory}.ts`, `deploy/monitoring/`, `docker-compose.yml`                                       | PostgreSQL persistant, Prometheus, tableaux Grafana existants à adapter                                                                                    |
| Cible dédiée              | `deploy/benchmark/{www,benchmark.nginx,provision.sh}`                                                          | Réutiliser les pages PHP bornées ; conteneuriser nginx/PHP-FPM, sans exécuter le provisioning VPS existant                                                 |
| Assistant                 | `modules/assistant/{provider,runpod}.ts`, `routes/assistant-routes.ts`, `frontend/src/assistant-*`             | Pont conversationnel compatible API LLM, contexte de plateforme et cartes de propositions ; conserver la gouvernance                                       |

Les adaptateurs existants sont des moteurs exécutés dans le backend ou par processus locaux, **pas une flotte distante**. `AttackAgent.run(config, allowedHosts, killSignal, onProgress)` est un contrat TypeScript en mémoire ; `AbortSignal` ne se transmet pas sur le réseau. Aucun manifeste Kubernetes, chart Helm ni référence Kusa trouvés dans les sources et documents examinés. La roadmap place encore flotte distribuée, mTLS agents et file durable parmi les chantiers futurs. L'implémentation de Kusa n'a pas été auditée ici : le contrat proposé ci-dessous devra être rapproché de son interface réelle.

### Écarts entre documentation et code

1. Le README exclut Slowloris et décrit GET/POST comme seul vecteur ; `BuiltinHttpAgent.run()` route pourtant `config.slowloris` vers le moteur slow-header borné, également reconnu dans `CLAUDE.md`. Les types de flows autorisent aussi PUT/PATCH/DELETE/HEAD. Documenter précisément ces capacités ; le MVP IoT proposé reste GET/POST complet.
2. README, architecture et commentaires décrivent encore `officer` et l'administration des limites par CISO. La matrice actuelle donne l'approbation à `ciso`, les limites et utilisateurs à `admin`, et transforme l'alias historique `officer` en `admin`. Le prompt assistant propose encore qu'un CISO applique les limites : corriger ce texte lors de l'implémentation.
3. `docs/servers/bench-dispatch.md` et `docs/lab-assessment.md` renvoient à `cross-repo-contract.md` et/ou `drs-validation-policy.md`, absents du checkout examiné ; plusieurs références de lignes de `app.ts` sont anciennes. Ne pas fonder le nouveau contrat sur ces liens manquants.
4. La sonde de campagne peut être distante, mais `captureBaseline(campaign.probeUrl, ...)` reste locale par défaut dans le runner ; la sonde de référence est locale également. Une comparaison avant/sous charge exige la même provenance, ou une séparation explicite des mesures.
5. Le probe-agent vérifie le hostname initial puis utilise `redirect: 'follow'`. Son `bodySlice` tronque après lecture du corps complet. Prévoir refus des redirections (ou revalidation de chaque saut), limite de lecture streaming et validation des adresses résolues ; NetworkPolicy complète l'allowlist, sans la remplacer.
6. Le runner sait corriger la disponibilité par le succès du générateur (`probeContended`). Conserver la mesure brute et la correction séparées : le rapport d'un laboratoire à sonde indépendante ne doit pas présenter une disponibilité substituée comme mesure indépendante.
7. Les gauges actuelles sont notamment étiquetées par cible et les timelines de certains moteurs externes manquent de compteurs live. Ajouter un chemin distribué explicite ; zéro, donnée absente et agent silencieux doivent rester distincts.

## 2. Choix du cluster

| Critère          | Mac local                                                                                                                          | VPS Linux                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Choix recommandé | **kind + Docker Desktop + Calico**                                                                                                 | **K3s mono-nœud**, réseau Flannel et contrôleur NetworkPolicy intégré                                |
| Usage            | Développer contrats, arrêt, réseau, reprise et rapports                                                                            | Vérifier fonctionnement Linux, persistance et contraintes CPU/RAM dans une étape ultérieure          |
| Réseau           | Nœuds conteneurisés dans la VM Linux ; IP de pods privées visibles entre pods, généralement pas routables directement depuis macOS | IP de pods privées sur réseau du cluster ; sorties publiques éventuellement SNATées par le nœud      |
| Isolation        | Désactiver le CNI par défaut de kind et installer Calico pour appliquer les politiques                                             | Garder le contrôleur NetworkPolicy actif ; désactiver Traefik et ServiceLB inutiles                  |
| Accès            | API/UI par port-forward lié à loopback ; kubeconfig dédié                                                                          | API Kubernetes et UI accessibles seulement par tunnel SSH/réseau privé, pare-feu hôte et fournisseur |
| Limites          | VM partagée, veille du Mac, contention et virtualisation ; ne représente pas un vrai parc IoT                                      | Un hôte partagé et une panne unique ; coût, politiques hébergeur, variabilité du VPS                 |

Décision : **commencer sur Mac**, conserver un socle de manifests Kustomize portable et deux overlays `kind`/`k3s`. kind se prête aux clusters jetables et aux tests de développement ; K3s réduit l'exploitation d'un petit serveur Linux. k3d reste une alternative si reproduire exactement K3s devient prioritaire, mais n'ajoute pas de valeur au premier MVP. Helm et un opérateur/CRD ne sont pas nécessaires à ce stade.

Vérifications officielles : [kind Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/) décrit les fournisseurs de conteneurs et les images de nœuds ; [configuration kind](https://kind.sigs.k8s.io/docs/user/configuration/) permet sous-réseaux, CNI personnalisé et liaison loopback ; [Calico sur kind](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind) documente l'installation sans CNI par défaut. Épingler une combinaison Kubernetes/kind/Calico compatible au moment de l'implémentation, ainsi que les digests d'images.

[K3s Requirements](https://docs.k3s.io/installation/requirements) indique un minimum serveur de 2 cœurs et 2 Go, insuffisant comme budget pour tous nos services ; [K3s Networking Services](https://docs.k3s.io/networking/networking-services) décrit son contrôleur NetworkPolicy et les services réseau intégrés. Vérifier architecture, noyau/cgroups, CIDR et ports inter-nœuds avant tout futur VPS ; ne pas ouvrir les ports overlay sur Internet.

## 3. Architecture du laboratoire

```text
Opérateur / Kusa (lecture + proposition, sans kubeconfig)
                      |
            API Ddostester + UI
             |         |
         PostgreSQL    | orchestration Kubernetes par adaptateur
                       v
        Coordinateur de flotte (1 réplique, baux persistés)
          |           |             |
       Job agent-0  Job agent-1   Job agent-2
          \           |            /
            HTTP borné vers Service cible -> nginx/PHP-FPM
                                      ^
             Sonde indépendante ------|
                      |
       collecteur / Prometheus -> Grafana + rapports Ddostester
```

Namespaces proposés : `ddostester-control`, `iot-lab`, `lab-observability`. Une seule campagne de flotte active pour le MVP. Trois Jobs agents, un pod par agent, chacun possédant une vraie IP privée distincte ; une Deployment cible, une Deployment sonde, un coordinateur, l'API et PostgreSQL. Le coordinateur peut être un module du backend au début, avec une responsabilité et une identité RBAC séparées ; ne pas dupliquer le scheduler existant.

Les profils IoT sont des scénarios applicatifs déterministes : petits GET de consultation et POST de télémétrie synthétique, cadence et think-time définis, identifiants simulés et graine enregistrée. Pas de firmware compromis ni de protocole de réflexion. Démarrer avec **3 agents × 5 RPS, 2 requêtes concurrentes par agent, 60 s** : total 15 RPS/6 concurrentes. Ce profil est une proposition, pas une campagne créée. Sonde et baseline ont leur propre petit budget documenté, inclus dans le plafond d'activité totale du laboratoire.

L'IP source à vérifier est celle réellement observée dans les logs nginx de la cible, et non un en-tête déclaré par le bot. Les agents n'utilisent ni `hostNetwork`, ni proxy de sortie, ni sidecar modifiant la source. Le Service cible reste ClusterIP ; valider expérimentalement la conservation des sources par le CNI/service choisi. Les IP sont éphémères : identité stable = `agentId` + UID pod + index de shard ; enregistrer l'IP pour chaque tentative. Aucun besoin de Multus, MetalLB ou attribution d'IP publique pour le MVP.

CIDR privés Pod/Service choisis après inventaire des routes Mac/VPN/VPS afin d'éviter les chevauchements. Une adresse RFC1918 seule ne constitue pas une autorisation : liste de cibles dédiée, DNS interne maîtrisé et politique réseau doivent toutes concorder.

### Isolation et accès

NetworkPolicy deny-all en ingress/egress, puis règles minimales : agents vers cible HTTP et coordinateur ; sonde vers cible ; API vers sonde/DB/coordinateur ; coordinateur vers API Kubernetes ; Prometheus vers endpoints de métriques. DNS uniquement vers CoreDNS, sans récursion externe pour les noms du laboratoire. Aucun accès agent à Internet, au LAN, aux métadonnées cloud ou à l'API Kubernetes. Traiter séparément trafic nœud/hôte et administration : les NetworkPolicies ne sont pas un pare-feu universel.

La [documentation Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/) précise que l'application dépend du plugin réseau et que les politiques sont additives. Tester effectivement les refus ; un namespace ou une politique déclarée ne prouve pas l'isolation. Précharger les images pour séparer l'accès registre des flux des pods.

Pods non privilégiés, utilisateur non-root, capacités supprimées, volumes minimaux ; `automountServiceAccountToken: false` pour agents et sonde. Seul le coordinateur a une Role limitée aux Jobs/pods nécessaires dans `iot-lab` ; pas de ClusterRole administrateur. Secrets distincts pour DB, sonde et agents, sans clés ni tokens dans les manifests suivis. Aucun NodePort/LoadBalancer/Ingress public. L'assistant LLM distant reste désactivé dans l'overlay isolé ; utiliser un stub local tant que son accès n'est pas prévu explicitement.

## 4. Contrat proposé Ddostester ↔ agents ↔ Kubernetes

Ce contrat **n'existe pas encore**. Ajouter un adaptateur `KubernetesFleetAgent` implémentant `AttackAgent` ; traduire son `AbortSignal` en révocation de baux et arrêt des Jobs. Ne pas réutiliser `/api/bench/*` : il s'agit d'un contrat classe C distinct, pas du cycle HTTP de campagne.

### Autorité, configuration et budgets

- Ddostester reste seul responsable de l'autorisation, de l'approbation valide, des caps effectifs et du run parent. L'agent n'accepte aucune cible, commande shell ou image arbitraire venant de Kusa.
- Enveloppe versionnée `ddostester.fleet.assignment/v1` : `campaignId`, `runId` parent, `agentId`, `attemptId`, `shardIndex`, `configHash`, cible et ports permis, profil/graine, budget de RPS/concurrence par phase, `notBefore`, deadline absolue, expiration du bail et configuration HTTP bornée.
- Réutiliser `LoadTestConfig` comme modèle de contenu validé, mais définir un schéma JSON réseau indépendant. Le plafond distribué concerne **la somme des agents**, pas le plafond accordé à chacun : à tout instant `sum(rps_i) <= budgetGlobal`, `sum(concurrency_i) <= budgetGlobalConcurrency`. Appliquer cette règle aussi aux phases, flows et reprises. Réserver explicitement le budget sonde/baseline.
- Snapshot des limites et de l'allowlist au lancement ; toute révocation de cible ou baisse de limites doit arrêter ou réduire l'activité de façon gouvernée. Le moteur dans chaque agent revalide la configuration et les destinations résolues. Les redirections sont refusées dans le MVP.
- Calibration automatique désactivée dans le MVP : le runner actuel peut effectuer une charge préliminaire supplémentaire. Une calibration future devra consommer un budget et une deadline globaux explicites, visibles au rapport.

### Transport interne et cycle de vie

API interne proposée, distincte des routes utilisateur : `POST /internal/fleet/claim`, `POST /internal/fleet/heartbeat`, `POST /internal/fleet/result`. Identités/tokens limités à un agent et un run ; transport mTLS prévu avant intégration au cluster équipe. Un stub en mémoire peut précéder le transport, mais ne remplace pas l'authentification du laboratoire.

États d'un shard : `PENDING -> LEASED -> RUNNING -> SUCCEEDED | STOPPED | FAILED | LOST`. Heartbeat toutes les 2 s, bail court de 6 s (valeurs proposées à centraliser). Bail expiré, deadline atteinte ou annulation : arrêt autonome et fermeture des connexions. Pas de reprise automatique de génération après perte réseau.

Claim atomique en PostgreSQL, lease et identifiant de tentative persistés. Une seule tentative autorisée à consommer un budget ; ne jamais réallouer le budget d'un agent perdu avant expiration de son autorisation et marge de fermeture. Numéros de séquence monotones, résultat final idempotent sur `(runId, agentId, attemptId)`, rejet des événements périmés ou incohérents. Réconciliation après redémarrage du coordinateur ; état incertain => arrêter, puis marquer incomplet, sans relancer la charge.

Créer un Job par shard avec `backoffLimit: 0`, `restartPolicy: Never`, `activeDeadlineSeconds`, grace d'arrêt courte et `ttlSecondsAfterFinished` après export des preuves. Ces champs sont décrits par la [documentation officielle des Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/). Kubernetes peut néanmoins produire des tentatives concurrentes ou répétées : la fencing logique du bail reste nécessaire. Kubernetes n'est pas une garantie « exactement une fois ».

Arrêt manuel/automatique/temporel : Ddostester révoque les baux, le coordinateur demande l'arrêt, les agents ferment leurs sockets, les Jobs sont supprimés si nécessaire. La deadline locale autonome est le dernier filet ; supprimer un objet Job seul ne prouve pas l'arrêt de toutes les requêtes. Objectif initial : plus de nouvelle requête au plus tard 8 s après un arrêt ou une perte de contrôle, à confirmer par logs cible horodatés.

### Mesures et agrégation

Heartbeat : timestamp UTC, durée monotone, numéro de séquence, état, UID/IP pod, compteurs cumulés envoyés/réussis/échoués, codes HTTP, histogramme de latences avec buckets communs, requêtes en vol, CPU/RAM et throttling. Résultat final : mêmes compteurs, motif d'arrêt, erreurs et références d'artefacts. Identifiant parent conservé ; les IDs générés localement par le moteur sont des IDs de shard, pas de nouveaux runs de campagne.

Sommer les compteurs, calculer le débit réel sur une fenêtre commune et fusionner les histogrammes : **ne pas moyenner les p95 des agents**. Documenter débit demandé, émis et reçu par nginx séparément. Conserver mesure brute de sonde, baseline de même vantage, timeouts, assertions et récupération après arrêt. Une sonde silencieuse ou un shard absent rend le résultat incomplet/inconclusif, jamais artificiellement bon.

Prometheus scrape API, agents, cible et sonde ; PostgreSQL conserve le run, les leases, événements et références d'artefacts. Volume dédié pour logs et histogrammes finaux ; exporter avant TTL. Adapter les tableaux Grafana existants. Le provider `TARGET_TELEMETRY_METRICS_URL` attend du JSON : prévoir un bridge depuis les mesures de cible, pas l'URL brute `/metrics` de Prometheus. Ne pas fabriquer de TTD/TTM : WRS reste signalé estimé lorsqu'aucune protection réelle n'est mesurée.

### Intégration Kusa

Première tranche : lecture des campagnes/runs/rapports et proposition structurée de profils. Le pont assistant existant ne possède pas d'outil d'exécution de campagne ; les routes de puissance RunPod existent séparément et ne doivent pas être déclenchées pour ce laboratoire.

Kusa produit une proposition validée par schéma et montrée à l'opérateur, puis le parcours existant création → approbation CISO → exécution par ingénieur s'applique. Le rôle admin ne devient pas approbateur. Pas de kubeconfig, clé cluster, shell, token runner ou capacité d'approuver dans le contexte LLM. Fournir à Kusa des résumés sans secrets, avec provenance des métriques et état inconclusif explicite. Avant branchement réel, confirmer interface Kusa, authentification, limites de données transmises et compatibilité du format des cartes ; ne pas supposer que son nom implique la compatibilité du provider actuel.

## 5. Étapes d'implémentation et livrables

1. **Réconcilier la documentation** : rôles, vecteurs réellement présents, liens manquants, capacités des agents ; mettre à jour la roadmap au même changement que le comportement. Définir schémas et invariants de caps globaux avant code de dispatch.
2. **Construire les images** : agent Node >=22 réutilisant le moteur HTTP, sonde existante corrigée, nginx/PHP-FPM pour `deploy/benchmark/www`. Images arm64/amd64, versions et digests épinglés, pas de provisioning host ni mode `PUBLIC_HTTP`.
3. **Écrire le socle Kubernetes** : `deploy/kubernetes/base/` et overlays `kind`/`k3s`, namespaces, policies, Secrets référencés, Services ClusterIP, requests/limits, quotas, stockage et comptes de service. Config kind avec Calico ; configuration K3s sans services publics automatiques. Documentation de création/destruction limitée au contexte lab.
4. **Implémenter l'orchestration** : adaptateur flotte, allocation entière des budgets, leases/heartbeats, arrêt distribué, persistance et réconciliation. Exposer les capacités dans `/api/agents`, sans repli silencieux sur builtin si la flotte demandée manque.
5. **Fiabiliser la mesure** : baseline distante identique à la sonde, métriques streaming des shards, collecte nginx et mesures cible, fusion des histogrammes et rapports par agent. Désactiver les calendriers récurrents du lab par défaut.
6. **Intégrer Kusa en lecture/proposition** avec stub, puis endpoint réel après validation du contrat ; tester le refus de toute auto-approbation/exécution.
7. **Valider ultérieurement sur Mac**, puis sur VPS privé avec la même suite ; toutes campagnes futures doivent suivre les approbations existantes. Cette première étape ne crée ni cluster ni run.
8. **Préparer le passage infrastructure** : fournir versions, manifests, matrice de flux, mesures, exigences RBAC/CNI/stockage et procédure d'arrêt. L'équipe validera ensuite les IP publiques, le SNAT/routage, les coûts/quotas et les règles d'accès ; aucun résultat du lab ne valide ces points.

## 6. Ressources et dépendances

Estimations de départ, à mesurer, distinctes des minima éditeur : Mac avec environ 6 vCPU et 8–10 Go attribués à la VM Docker, 20 Go de disque libre ; VPS Linux 4 vCPU/8 Go RAM/30 Go SSD. La capacité réelle des machines n'a pas été inspectée. Une flotte à 15 RPS n'exige pas une infrastructure volumétrique.

| Service              | Budget initial proposé                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| API + coordinateur   | request 500m CPU/512 MiB ; limit 1 CPU/1 GiB                                |
| 3 agents             | chacun request 100m/128 MiB ; limit 250m/256 MiB                            |
| Cible nginx/PHP-FPM  | request 500m/512 MiB ; limit 1 CPU/1 GiB ; pool PHP borné                   |
| Sonde                | request 100m/128 MiB ; limit 250m/256 MiB                                   |
| PostgreSQL           | request 250m/512 MiB ; limit 1 CPU/1 GiB ; PVC 2 GiB                        |
| Prometheus + Grafana | budget combiné initial 500m/1 GiB, limite 1 CPU/2 GiB ; PVC métriques 5 GiB |

Réserver en plus de la marge pour Kubernetes, CNI, DNS et runtime. Quotas de namespace et nombre maximal de Jobs verrouillent la taille de flotte ; requests/limits CPU n'imposent pas un plafond de RPS. PVC métriques avec rétention courte (par exemple 24 h), artefacts finaux conservés/exportés avant nettoyage ; chiffrer et sauvegarder les données si le lab devient durable.

Dépendances : Git, Node >=22/npm existants, Docker Desktop sur Mac, kind, kubectl/Kustomize, Calico ; Linux avec K3s/containerd sur VPS ; PostgreSQL 16 réutilisable, Prometheus/Grafana, nginx/PHP-FPM. Aucun GPU ni moteur externe k6/Vegeta n'est indispensable au MVP. Installer un moteur externe seulement pour une comparaison gouvernée ultérieure. Aucun outil ni paquet installé durant cet examen.

## 7. Critères de validation futurs

- Manifests renderables avec Kustomize, schémas et RBAC vérifiés ; CI sur les modifications de comportement selon `CONTRIBUTING.md`/`CLAUDE.md`.
- Trois IP privées sources distinctes effectivement vues par la cible ; sonde avec quatrième source distincte. Aucun `X-Forwarded-For` utilisé comme preuve de source.
- Refus réseau vers destinations non autorisées, LAN, Internet et métadonnées ; refus cible non allowlistée, redirection externe et DNS hors périmètre. Tests synthétiques dans le lab, jamais sondage d'un hôte réel non autorisé.
- Une proposition Kusa ne lance rien ; un auteur n'approuve pas sa campagne ; limites effectives et plafond global persistent après redémarrage. Config/fencing périmés rejetés.
- Somme des budgets des shards <= budget global à chaque phase ; débit observé contrôlé dans les fenêtres documentées avec tolérance d'ordonnancement explicite. Aucun double budget pendant redémarrage ou remplacement de pod.
- Arrêt manuel, auto et deadline : aucune nouvelle requête après l'objectif de 8 s ; même résultat lors d'une coupure de contrôle. Agent perdu => résultat incomplet ; reprise sans trafic automatique.
- Baseline et sonde sous charge de même provenance ; probe indépendant du processus générateur. CPU throttlé et saturation collecteur distingués d'une dégradation cible.
- Compteurs agent et cible rapprochés, pertes/décalages expliqués, histogrammes fusionnés, p95 non moyennés ; zéro et données absentes différenciés. Rapports avec commit, digests, versions cluster/CNI, configuration, IP/UID, timestamps et budget total.
- Export des preuves avant nettoyage, absence de secrets dans logs/rapports, métriques et coût de cardinalité bornés.

## 8. Limites et décisions encore ouvertes

Le laboratoire valide l'orchestration, l'arrêt, les contrats et la mesure d'une petite flotte HTTP. Il ne démontre ni capacité DDoS réelle, ni firmware IoT, ni diversité géographique, ni capacité de protection Internet. Des pods distincts ne sont pas des machines indépendantes ; un VPS mono-nœud ne fournit ni HA ni plusieurs IP publiques sources. Une sonde sur le même hôte reste indépendante du générateur logiciel mais partage les pannes CPU/réseau de l'hôte.

Les mesures Mac et VPS sont comparables fonctionnellement, pas comme classement de débit absolu. Les IP publiques, adresses sortantes SNAT, ACL, topologie du cluster équipe, politique CNI et séparation physique de la sonde restent à valider avec infrastructure. Le dépôt externe `shieldtest-lab` et les interfaces effectives de Kusa n'ont pas été inspectés ; les affirmations à leur sujet provenant de la documentation locale ne sont pas des validations de leur code.

Première étape réalisée : lecture du dépôt et des sources officielles, examen de l'état Git, proposition documentaire. Aucun test de charge, processus applicatif, script de provisioning, installation, requête assistant/RunPod ni déploiement externe lancé. Les scénarios de validation ci-dessus sont des travaux futurs, pas des résultats acquis.

## Prérequis issus de l'audit applicatif

Le premier lab garde un seul replica de contrôle plane. Un verrou PostgreSQL de
runtime refuse un second processus sur la même base ; les kill switches et suites
restent locaux. Ne pas déployer plusieurs bases indépendantes pour contourner ce
verrou. La distribution aux agents reste une étape d'implémentation, avec leases,
budget global et acquittement d'arrêt, et non une fonction déjà disponible.

Toutes les destinations (target, probe, reference, flows) doivent être validées
avant I/O. Redirections automatiques désactivées sur les transports et adaptateurs.
NetworkPolicy ferme l'egress vers LAN/Internet/métadonnées ; DNS limité au résolveur
et aux noms du lab. Les agents ne possèdent pas de droit d'élargir l'allowlist.
Les seuils d'arrêt de la sonde restent indépendants des succès du générateur ; une
divergence dégrade la confiance du rapport et ne remplace pas les mesures brutes.
Les réponses et sorties de processus sont bornées ; arrêt SIGTERM puis SIGKILL du
groupe de processus. Aucun déploiement ou trafic de lab lancé lors des corrections.
