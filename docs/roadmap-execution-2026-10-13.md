# Exécution de la roadmap Ddostester

La roadmap R01–R10 est en cours d’exécution sur la base de la release 451. Le laboratoire local possède maintenant une cible dédiée, une sonde distante, un contrôle plane et un service de coordination mTLS. Une première flotte de trois agents a terminé une campagne bornée avec 21 requêtes, corroborées par 21 reçus côté cible. Le VPS applicatif conserve la release 451 pendant la recette des nouveaux composants.

## État des lots

| Lot | Implémentation et preuves disponibles                                                                                                                           | Travail restant                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R01 | Sauvegarde des sources locales ; déploiement CI lié au SHA qui a passé les checks ; Docker utilise npm ci, le manifeste API/UI et des dépendances de production | Référence Git propre et finalisation des statuts documentaires                                                  |
| R02 | Job PostgreSQL obligatoire en CI ; rollback imbriqué, révocations concurrentes, reçu d’audit et singleton vérifiés ; concurrence du store mémoire corrigée      | Recovery du propriétaire et recette navigateur élargie                                                          |
| R03 | Sauvegardes quotidiennes chiffrées, restauration vérifiée des 11 comptes/sessions et de l’audit, réplication hors hôte, témoin signé et alertes de fraîcheur    | Rotation/escrow durable des clés et rétention dimensionnée                                                      |
| R04 | Baseline, charge et récupération utilisent la même sonde distante ; validation des samples et lectures bornées ; données CPU/NIC absentes conservées inconnues  | Qualité de la sonde et indépendance physique à mesurer                                                          |
| R05 | Cluster kind 0.33 / Kubernetes 1.37 avec Calico 3.33 ; refus réseau par défaut ; DNS limité au lab ; non-root et services internes                              | Scripts de création/destruction reproductibles et recette Linux                                                 |
| R06 | Assignment/budgets hashés, mTLS, baux/deadlines, veto avant transport, CPU/RAM/throttling et provenance claim/snapshot persistés                                | Rotation des identités et recette applicative Linux                                                             |
| R07 | Claims atomiques, fencing, réservation globale, bail parent ; arrêts manuel/crash/freeze recettés ; nettoyage et collecte bornée de logs                        | Partitions réseau supplémentaires et preuve de suppression après échec API                                      |
| R08 | Histogrammes fusionnés, reçus cible et sources privées, confiance dégradée, exports avec SHA-256, reçus/logs Jobs persistés avant nettoyage                     | Dashboards et rétention/export automatisé des bundles                                                           |
| R09 | Propositions versionnées et cartes validées, bornes contexte/sortie/flux, choix moteur respecté ; panneaux terminal/live et aperçu clavier/mobile               | Quotas journaliers/provenance provider, six moteurs réels, parcours navigateur complet et interface réelle Kusa |
| R10 | Overlay K3s préparé ; ressources VPS2 inspectées : 2 vCPU, environ 8 Go RAM, environ 47 Go disque libre                                                         | Recette Linux isolée et dossier de compatibilité infrastructure                                                 |

Les cases indiquent des travaux livrés ou des preuves acquises, sans déclarer tous les lots terminés. Les étapes conditionnelles SSO, multi-tenant et HA du backlog restent soumises à leur besoin métier et aux garanties de coordination.

## Garanties du laboratoire

Le MVP distribué accepte uniquement GET vers `lab-target:8080`, 3–15 RPS agrégés, 3–6 connexions concurrentes et 10–60 secondes. Il utilise trois agents, une sonde distante explicitement demandée et un contrôle plane unique. Calibration, flows, références supplémentaires et scheduler sont refusés pour cette flotte.

Les assignments et résultats sont persistés dans PostgreSQL. Les agents ne reçoivent pas de token Kubernetes, de clé DB ou de droit d’élargir le scope. Leur certificat identifie l’agent sur le service de contrôle. Les budgets ne sont pas réattribués après perte d’un agent. La session de l’opérateur et les limites courantes sont revalidées pendant le run.

Le service de flotte ne peut prolonger un bail agent au-delà du bail du contrôle plane. L’agent vérifie aussi sa permission juste avant chaque requête, pour empêcher une reprise après suspension et expiration. Au redémarrage, une campagne distribuée interrompue devient CANCELLED avec une trace transactionnelle ; elle n’est pas rejouée automatiquement.

Le bind de l’API reste une IP privée de pod. Un proxy borné lié seulement à loopback dans ce pod permet l’accès opérateur par port-forward sur 8081. Aucun service de l’application n’est publié sur Internet.

## Mesures et résultats acquis

- Flotte fonctionnelle : 3 agents SUCCEEDED, 21 requêtes et 21 échantillons d’histogramme.
- Réception cible : maximum de 21 reçus taggés, correspondant aux 21 requêtes, sur trois IP privées distinctes.
- Sonde : 10 échantillons disponibles dans cette recette ; quatrième source privée corroborée dans la recette réseau.
- Arrêt manuel : trois shards STOPPED, campagne KILLED_MANUAL ; dernière nouvelle requête 1 873 ms après l’arrêt.
- Perte d’agent : suspension réelle depuis le namespace parent, puis reprise ; shard LOST, mesure incomplète et confiance dégradée.
- Crash du contrôle plane : dernière nouvelle requête observée 1 765 ms après SIGKILL ; aucun démarrage sur une cible de production.
- Réseau : un pod non autorisé ne peut pas joindre la cible. Les IP sont celles vues par nginx, sans X-Forwarded-For.
- Gate complet relevé : 999 tests backend et 391 frontend, lint/types/builds réussis. Gate PostgreSQL spécifique : 26 tests ; signatures de témoin : 2 tests. Les suites conditionnelles de la vérification générale sont complétées par le job PostgreSQL dédié.

Les percentiles de flotte sont des bornes supérieures issues d’histogrammes fusionnés, jamais une moyenne de p95. Les observations absentes rendent le résultat incomplet. Une interruption volontaire ne doit pas être comptée comme un hard backstop. Les rapports séparent succès HTTP, erreurs, réception cible et attribution à une protection ; aucune protection réelle n’est déduite des seuls échecs du générateur.

La cible est un nginx/PHP-FPM conteneurisé avec pool et délais bornés. Son sidecar lit des reçus JSON locaux et expose un bridge JSON compatible avec le provider existant. Les compteurs sont séparés par campagne et run. Une rotation avec perte, un parsing invalide ou un changement de pod cible rend les reçus incomplets. CPU/NIC restent inconnus tant qu’une vraie source ne les fournit pas.

## Témoin d’audit externe

VPS1 expose uniquement une commande SSH forcée de vérification, avec une identité dédiée et un rôle PostgreSQL limité à SELECT sur l’audit. Les droits de mutation, de port-forward et de shell de cette identité sont absents. Les comptes humains et leurs mots de passe ne sont pas modifiés.

VPS2 conserve des checkpoints exclusifs, chaînés et signés Ed25519 toutes les cinq minutes. La clé de signature et la clé SSH de collecte restent sur VPS2 hors des releases et des pods. Plusieurs checkpoints consécutifs ont passé la vérification de continuité ; Prometheus et Grafana sont toujours actifs.

```bash
systemctl status ddostester-audit-witness.timer
journalctl -u ddostester-audit-witness.service --since today
```

Les scripts sont dans `scripts/operations/witness/` et les unités dans `deploy/operations/`. Le collecteur prouve la continuité des têtes retenues sous l’hypothèse de séparation des accès applicatifs et du collecteur. Il ne protège pas contre un administrateur qui possède les clés et les droits root des deux hôtes. Une vérification dépassant son budget de 100 000 entrées échoue explicitement et doit déclencher une intervention d’exploitation.

## Récupération et secrets

Le cycle quotidien est installé sur VPS1 : `ddostester-database-backup.timer`, 02:30 UTC avec cinq minutes de jitter. Il crée une archive exclusive AES-256-GCM et un reçu SHA-256, puis remplace atomiquement `latest.json` après réussite. Le premier cycle a produit 1 523 136 octets de dump (1 523 185 octets chiffrés). Sa restauration authentifiée dans une base temporaire vide a préservé exactement les **11 comptes et leurs sessions** ainsi que **2 637 lignes d’audit**. La base de recette a ensuite été supprimée ; l’application est restée active. Aucune ancienne archive n’est supprimée automatiquement.

La réplication quotidienne est installée sur VPS2 : `ddostester-backup-replica.timer`, 03:00 UTC avec cinq minutes de jitter. Son identité SSH dédiée ne peut exécuter que `backup-export.mjs` sur VPS1, sans forwarding, shell interactif ou accès à la clé de chiffrement. Le collecteur vérifie taille et SHA-256 avant publication exclusive ; un second transfert a confirmé l’idempotence. Le chiffrement authentifié reste vérifié pendant la restauration, distinctement du SHA-256 de transport. Le répertoire de copie est `/var/lib/ddostester-backup-replica`, privé root.

Les scripts sont installés dans `/usr/local/lib/ddostester-operations`. Sur VPS1, `/etc/ddostester-backup.env` et `/etc/ddostester-backup.key` sont privés (0600). Le service écrit dans `/var/lib/ddostester-backups`. Une copie de récupération de la clé est conservée sur le Mac dans `/Users/abdelhatayeb/.local/share/ddostester-recovery/vps1-backup-2026-10-13.key`, mode 0600, parent 0700, hors dépôt. Cette copie dépend du Mac : une conservation indépendante durable et la rotation restent à organiser.

Sur VPS2, `ddostester-freshness.timer` publie chaque minute les timestamps du backup répliqué, de la réplication et du témoin dont toute la chaîne de signatures est vérifiée. Le node exporter existant expose ces métriques par son collecteur textfile. Des alertes Prometheus détectent backup/réplication de plus de 30 heures, témoin invalide ou de plus de 15 minutes et métriques de plus de trois minutes. Les configurations précédentes ont été conservées avant modification. `promtool check` et `promtool test rules` ont réussi pour les preuves fraîches, vieillies et absentes ; la publication réelle a été vérifiée. Aucune notification artificielle n’a été déclenchée pour cette recette. Les services Prometheus et Grafana sont restés actifs.

Le nettoyage des Jobs et des connexions de flotte tente désormais toutes les étapes même si l’une échoue. Il émet `fleet.cleanup.failed` avec le run et l’action concernés, sans contenu d’exception. Un test de défaillance du coordinateur et du reporter confirme la fermeture des ressources suivantes ; le contrôle TypeScript passe. La confirmation effective de suppression Kubernetes reste distincte de l’acceptation d’une demande DELETE.

`database-backup.mjs` produit une archive AES-256-GCM avec un fichier clé de 32 octets privé. La récupération déchiffre et authentifie entièrement l’archive avant d’accéder à PostgreSQL ; elle exige une base vide distincte et utilise une transaction unique pour pg_restore. `recovery-check.mjs` exerce backup, restore, comparaison des comptes/sessions/audit et refus d’une archive altérée.

La base jetable locale et la base Kubernetes sont distinctes du VPS applicatif. Les credentials du lab, CA et kubeconfig sont conservés dans des fichiers protégés hors du dépôt. Aucun mot de passe de production n’est copié dans les manifests. La sauvegarde des sources initiales est conservée dans `/private/tmp/ddostester-roadmap-start-20261013`.

## Limites et raccordement infrastructure

Les pods partagent le même hôte et ses pannes ; une IP privée distincte ne constitue ni une machine IoT réelle ni une IP publique distincte. La recette à très faible charge valide l’orchestration et les contrats, sans classement de performance ou certification de protection Internet. Les IP publiques, SNAT, règles du cluster équipe et séparation physique de la sonde restent à valider avec infrastructure.

Le VPS2 inspecté possède moins de CPU que l’enveloppe initiale de 4 vCPU proposée dans la roadmap. Une recette Linux doit isoler ses ressources et préserver les services de monitoring existants. Aucun raccordement au cluster équipe ni validation d’IP publiques n’est annoncé à ce stade.

Sources : [roadmap](./improvement-roadmap-2026-10.md), [release 451](./audit-release-2026-10-13.md), [configuration kind](https://kind.sigs.k8s.io/docs/user/configuration/), [NetworkPolicy Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [installation Calico sur kind](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind), [restriction des namespaces CoreDNS](https://coredns.io/plugins/kubernetes/).

## Export des preuves de flotte

Un export de preuves persistées est disponible dans la source via `GET /api/runs/:runId/fleet-evidence.json`, permission `campaign:read`, cache désactivé. Le contrat `ddostester.fleet.evidence/v1` contient compteurs, histogrammes, provenance des shards, ressources, sonde, timeline et reçus cible ; il exclut les configurations de transport (headers, corps, URL avec query). Les shards sans résultat restent absents. Le SHA-256 permet de détecter une altération du contenu sérialisé, sans authentifier l’émetteur. Le contrôle TypeScript et le test d’export/altération passent ; le bundle du run réel `ab8255f2-3f97-4f54-90e8-9a3de3702a10` a été produit hors dépôt. La recette HTTP Fastify passe : anonyme refusé, viewer autorisé, 404 pour un run absent, cache désactivé et SHA-256 vérifiable. Le contrôle plane collecte maintenant, avant la suppression des Jobs, un reçu par Job contenant nom, UID, image, deadline, backoff et état observé. Les annotations et valeurs d’environnement sont exclues. Une lecture indisponible reste explicitement `available:false`. Le test de sélection des champs passe ; la recette de collecte dans le cluster reste à effectuer. Les manifests complets et logs Kubernetes ne sont pas encore conservés.

## Sélection des moteurs

Le choix explicite d’un générateur indisponible ou inconnu est désormais refusé au lieu d’être remplacé par le moteur par défaut. L’auto-sélection d’un moteur externe à haut débit ne s’applique qu’au choix « Server default ». Le guide de l’interface indique le blocage d’exécution pour un outil indisponible. Les tests de résolution prouvent qu’un k6 indisponible ne déclenche ni disponibilité ni génération sur le moteur par défaut ; les contrôles TypeScript API/UI et 31 tests ciblés de registre, sélection et intégration passent. La recette des six binaires réels reste ouverte.

## Bornes du fournisseur Kusa

Le fournisseur limite désormais l’historique à 16 000 caractères au total en conservant les tours les plus récents, le contexte ajouté à 8 000 caractères et le prompt à 8 000 caractères. La configuration borne la sortie à 4 096 tokens et la durée à 120 secondes ; le relais coupe aussi un flux dépassant 512 Kio, même si le fournisseur ignore sa limite de tokens. Ces bornes de caractères ne constituent pas une mesure exacte de tokens du tokenizer Kusa. Une recette Fastify avec fournisseur simulé confirme trois dépassements successifs : événement d’erreur, absence de succès final, annulation du transport et libération du créneau de chat. Les quotas journaliers persistants, la recette avec le moteur réel et la revue du contenu envoyé restent ouverts.

## Mesures de ressources des agents

Le résultat final d’un agent inclut désormais `ddostester.fleet.resources/v1` : CPU utilisateur/système du processus en microsecondes sur l’affectation, RSS au retour et pic RSS sur la vie du processus. Les deltas `throttled_usec` et `nr_throttled` sont lus séparément dans le cgroup v2 ; ils restent `null` si les fichiers ne sont pas disponibles, si les compteurs sont invalides ou diminuent. Aucun pourcentage CPU hôte n’est déduit de ces données. Les métriques d’un agent perdu restent absentes ; elles ne remplacent pas un résultat manquant. Le test de parseur couvre l’absence, les valeurs négatives et le dépassement d’entier ; six tests ressources/bail/nettoyage et le contrôle TypeScript passent. Les résultats des recettes conteneurisées sont décrits ci-dessous ; l’exposition aux dashboards reste à effectuer.

La recette du run `ab8255f2-3f97-4f54-90e8-9a3de3702a10` a ensuite confirmé les ressources dans les trois conteneurs Linux locaux : 24 requêtes, 24 reçus nginx et trois IP sources privées distinctes, tous les shards SUCCEEDED. Le RSS final était compris entre 78 et 82 Mo environ. Un agent a rapporté 1 206 845 µs de throttling sur 8 194,6 ms de mesure, ce qui dépasse le seuil diagnostique de 10 %. Le calcul de confiance signale désormais cette contention sans corriger le score cible ni attribuer le manque de débit à la cible. Huit tests confiance/contention passent. Le flag a ensuite été vérifié dans le résultat API du run `fa9354a3-59ae-432a-8490-1a6c542c9168`, décrit ci-dessous. La vérification complète précédente avait passé 1 007 tests backend, 391 frontend, lint, types et build ; 21 tests conditionnels étaient ignorés hors leur job PostgreSQL.

## Recette des reçus et cartes versionnées

Le run `fa9354a3-59ae-432a-8490-1a6c542c9168` a persisté trois reçus de Jobs disponibles, contenant leurs UID, l’image immuable `87eb4af9f0c24346598665afa110915040ec7eb3815470d69d9525a44f15a8dd`, la deadline de 18 secondes et `backoffLimit:0`. Leur état Kubernetes était encore actif au moment de la collecte : le résultat applicatif précède la sortie du processus. Les Jobs ont ensuite été supprimés et leur absence vérifiée. Le run a envoyé 24 requêtes ; deux agents ont terminé et un s’est arrêté à la deadline. La confiance est dégradée pour cette preuve incomplète et pour la contention CPU observée. Aucun résultat complet n’est déduit de cette recette.

Le prompt par défaut émet désormais le schéma `ddostester.kusa.proposal/v1`. Les cartes versionnées conservent la proposition originale et appellent le validateur serveur avant création de campagne ou modification des limites. Un refus de champs d’autorité injectés bloque la création. Les anciennes cartes sans schéma restent soumises aux endpoints de gouvernance existants. Les contrôles TypeScript API/UI et les tests de cartes/parsing passent ; la recette navigateur avec le fournisseur réel reste ouverte.

## Collecte reproductible de preuves runtime

La commande `node scripts/operations/lab-evidence.mjs KUBECONFIG RUN_UUID NOUVEAU_REPERTOIRE` exige un kubeconfig explicite du contexte `kind-ddostester-lab` dont l’API est sur loopback. Elle lit au plus trois Jobs/pods de la flotte du run, vérifie leur filiation par UID, collecte leurs images et états ainsi que 200 lignes/64 Kio maximum de logs par agent. Elle crée un répertoire 0700 et un bundle JSON 0600 avec SHA-256 ; un répertoire existant est refusé. Aucun Secret n’est lu. Les logs restent des preuves privées d’exploitation.

Le run `c81bd88b-e65b-4c81-9bc3-8ccd7886284b` a permis une collecte de trois pods pendant la charge, puis a terminé avec trois SUCCEEDED et 21 requêtes. Une collecte après nettoyage du run précédent a correctement signalé `missingJobs:true`, sans inventer de logs. Cette commande est un outil de collecte ponctuelle : elle ne garantit pas encore l’archivage automatique des dernières lignes avant nettoyage, qui reste à intégrer.

La collecte automatique des logs est maintenant implémentée dans la source : le rôle du contrôle plane peut lire les pods et `pods/log` du namespace laboratoire, en plus des Jobs. Le collecteur sélectionne le pod du Job et vérifie son owner UID avant lecture. Il conserve au plus 200 lignes/64 Kio par agent, marque l’échec de lecture et ne confond pas un pod absent avec des logs disponibles. L’agent écrit un événement de fin de mesure avant de poster son résultat pour rendre cette preuve observable avant nettoyage. Les trois tests d’export/HTTP/reçu et TypeScript passent. La reconstruction et la recette conteneurisée de cette collecte sont en cours ; les snapshots ne constituent pas un historique complet des logs.

Le run `7c0b6ba8-ab8e-48f7-9031-db7c57919a59` a confirmé la collecte automatique de trois snapshots de logs disponibles, chacun contenant `fleet.measurement.finished`, conservés dans le résultat après nettoyage. Les trois agents ont terminé, pour 24 requêtes. Le nouveau panneau de résultat présente l’état des agents, les IP privées, RAM, CPU et throttling ainsi que UID, tentative et dernier bail enregistré. Il distingue explicitement cet historique de la santé courante et affiche `unknown` pour les mesures absentes. Quatorze tests UI ciblés et TypeScript passent ; la recette visuelle et l’écran de santé live restent à effectuer.

La provenance persistée inclut maintenant le budget individuel (RPS, concurrence, durée) et le hash de la dernière affectation du coordinateur ; le résultat agent conserve aussi le hash de l’affectation reçue au claim. Ces deux hashes peuvent différer après renouvellement du bail, qui fait partie du contenu hashé. Le test PostgreSQL réel vérifie que les budgets de trois shards conservent exactement 15 RPS et six connexions, et que le hash au claim est celui du snapshot correspondant. Le gate PostgreSQL complet passe : 26 tests. Les types API/UI et six tests ciblés de panneau, agrégation et export passent. Le panneau affiche le budget, sans présenter la dernière lease comme une preuve de santé actuelle.

## Observation de la flotte active

`GET /api/fleet/status` est ajouté à la source, sous permission `campaign:read` et `Cache-Control:no-store`. Il lit le dernier run du coordinateur et au plus trois agents par un unique SELECT cohérent, avec timeout PostgreSQL de deux secondes. Il expose état enregistré, deadline, baux, expiration observée, budgets, hash et dernier progrès. Il ne renouvelle ni n’expire ni ne réassigne un agent. `available` indique uniquement la disponibilité de lecture du coordinateur (`availabilityScope:coordinator-read`), pas la santé de tous les agents ; une lease expirée ne prouve pas que le processus est arrêté. Les détails de connexion restent hors réponse. Le test PostgreSQL réel confirme que cette lecture laisse un agent RUNNING inchangé après expiration ; les 26 tests du gate passent. Le contrôle d’accès HTTP est couvert par le test d’export ; l’intégration à l’écran live reste à faire.

Le panneau `FleetLivePanel` est raccordé à Run Theater lorsqu’une campagne de flotte est RUNNING. Il lit l’API toutes les deux secondes après la fin de la requête précédente, arrête le polling au démontage et supprime l’ancien snapshot après erreur de lecture. Il affiche le dernier run du coordinateur, les tentatives, les budgets, le progrès disponible et les baux expirés à l’observation. Une mesure manquante reste `unknown` ; une erreur réseau/session n’est pas présentée comme un agent sain. Le panneau rappelle qu’une expiration n’est pas une preuve d’arrêt du processus. Douze tests UI ciblés et TypeScript passent. La recette visuelle sur petit écran/clavier et la lecture depuis le cluster restent ouvertes.

## Recette visuelle des panneaux de flotte

Un aperçu local des composants réels a été contrôlé dans Chrome à 360 et 1 280 pixels avec API de statut simulée. Les captures ont été examinées : pas de débordement horizontal de page, tableau défilant au clavier sur mobile, focus visible et détails d’identité ouvrables avec Entrée. Les longues identités restent dans le conteneur après ouverture. Les tableaux ont des captions, des en-têtes sémantiques et une région de défilement nommée/focusable. Les trois tests des panneaux et TypeScript passent. Cet aperçu vérifie les composants ; il ne prouve pas encore le parcours complet authentifié de Run Theater avec le coordinateur du cluster. Les fichiers temporaires de l’aperçu et son serveur ont été supprimés après recette ; les captures sont hors dépôt dans `/private/tmp/ddostester-fleet-{360,1280}.png`.

## Préparation de la recette Linux

Les documentations officielles K3s et k3d ont été revérifiées. La recette préparée utilise k3d pour conteneuriser K3s, conserver les services systemd de monitoring et limiter la consommation du nœud laboratoire. `deploy/kubernetes/overlays/k3s/cluster.yaml` réserve un cluster nommé `ddostester-linux-lab`, API loopback 16643, réseau Docker `172.30.94.0/24`, pods `10.247.0.0/16` et services `10.98.0.0/16`. Traefik, ServiceLB et metrics-server sont désactivés ; le contrôleur NetworkPolicy K3s reste actif. Le kubeconfig par défaut n’est ni fusionné ni sélectionné. L’overlay contient aussi le résolveur limité au namespace laboratoire, sans forwarding externe, et son rendu Kustomize passe.

Les versions candidates sont verrouillées dans `tools.lock.json` : k3d 5.9.0 (checksum de l’asset officiel) et K3s 1.37.1+k3s1 (digest OCI multiarchitecture vérifié dans le registre). Elles ne sont pas encore installées/recettées sur le VPS. Les routes du VPS inspecté ne chevauchent pas ces CIDR ; un nouveau contrôle reste nécessaire avant création. Le VPS dispose d’environ 6,9 Go RAM disponibles et 47 Go disque libres ; l’enveloppe de recette proposée est un nœud de 4 Go RAM et 1,5 CPU, à appliquer avant les workloads.

Cette recette sur un hôte qui conserve le monitoring est une étape de compatibilité conteneurisée. Elle ne remplace pas la preuve d’indépendance d’un VPS dédié demandée pour le raccordement infrastructure. Aucun nouveau VPS payant ou cluster équipe n’est provisionné à ce stade. Sources : [configuration k3d](https://k3d.io/stable/usage/configfile/), [contrôleur NetworkPolicy K3s](https://docs.k3s.io/networking/networking-services), [release k3d 5.9.0](https://github.com/k3d-io/k3d/releases/tag/v5.9.0), [release K3s](https://github.com/k3s-io/k3s/releases/tag/v1.37.1%2Bk3s1).

L’outil k3d 5.9.0 est installé dans `/usr/local/lib/ddostester-lab` sur VPS2, après vérification SHA-256 de l’asset officiel. Le script reproductible `scripts/operations/linux-lab-create.py` contrôle l’architecture, les hashes outil/configuration, l’absence de cluster existant, les conflits CIDR, 5 Go de RAM disponible, 20 Go de disque libre et le port loopback. Il conserve un état privé par opération, limite le nœud à 4 Go RAM et 1,5 CPU, vérifie l’exposition API puis écrit un kubeconfig séparé 0600. Il refuse de remplacer un état existant et conserve les ressources partielles si la création échoue, pour inspection.

La création a été lancée par l’unité `ddostester-linux-lab-create.service` ; l’observation confirme un processus de création actif et le téléchargement de l’image K3s dans le réseau dédié. Prometheus et Grafana étaient actifs pendant cette observation. Le cluster n’est pas encore déclaré prêt, et aucun workload applicatif Linux ni campagne n’est lancé tant que cette création n’est pas terminée et vérifiée.

L’observation suivante a confirmé l’échec terminal de `ddostester-linux-lab-create.service` : k3d a refusé la préparation du nœud auxiliaire avec « No nodes found for given cluster » après téléchargement de l’image, avant création d’un nœud serveur. Le réseau partiel et les logs restent conservés ; aucun workload ni campagne Linux n’a été lancé. La reprise exige d’abord le diagnostic de cette incompatibilité, sans réutiliser aveuglément l’opération échouée.

Le diagnostic du code officiel k3d 5.9.0 a identifié l’option `--no-image-volume` : `EnsureToolsNode` exige ce volume pendant la préparation concurrente. La recette conserve désormais le volume géré par k3d et épingle aussi `k3d-tools:5.9.0` par digest OCI. Le helper est plafonné à 0,5 CPU/256 Mio avant les workloads. Les seuls conteneur/réseau partiels de la première tentative ont été identifiés puis supprimés ; leurs preuves et logs sont conservés. Une seconde création est lancée sous `ddostester-linux-lab-create-02.service`, dans un état distinct, sans réutiliser la tentative échouée. Source du diagnostic : [tools.go, k3d v5.9.0](https://github.com/k3d-io/k3d/blob/v5.9.0/pkg/client/tools.go).

La seconde tentative a effectivement créé un nœud K3s Ready. Le post-check a été corrigé pour accepter la disparition normale du helper temporaire ; un vérificateur séparé a confirmé image, version, réseau hors host, absence de port supplémentaire, API loopback et plafonds 1,5 CPU/4 Go. La suppression du cluster vide a ensuite été exercée par `linux-lab-delete.py` : identité de création et labels contrôlés, refus des namespaces inconnus et des données persistantes hors scope, preuves de tentative conservées. La recréation complète par le script corrigé a réussi dans `attempt-03` : unité active/exited avec Result=success, nœud Ready, plafonds vérifiés et monitoring actif. Les workloads applicatifs Linux restent absents à cette étape.

La recette de création/suppression/recréation du socle Linux est donc acquise. Elle utilise K3s `v1.37.1+k3s1`, containerd 2.3.4-k3s1, API loopback 16643 et nœud plafonné à 1,5 CPU/4 Go, sans réseau ou PID du host. Le helper k3d est normalement supprimé à la fin ; s’il demeure présent, le vérificateur contrôle son image et le plafonne. L’unité de la tentative 02 conserve son échec de post-check historique ; la tentative 03 fournit une preuve de succès propre. L’application, la base de recette, les certificats et la flotte restent à installer dans ce cluster.

La sauvegarde initiale des travaux locaux a aussi été copiée durablement hors des fichiers temporaires dans `/Users/abdelhatayeb/.local/share/ddostester-roadmap-backups/2026-10-13-start`, parent/répertoire 0700 et fichiers 0600. Le SHA-256 de l’archive source conservée est `feca99c91c29f548e77f8681b366adcafb7a69fe0d055032d28bacbaae491251`. Le checkout et l’index Git de travail n’ont pas été réinitialisés.

Les cinq images de laboratoire ont été construites et inspectées en `linux/amd64` sur le Mac : contrôle plane/agent/service flotte, cible, sonde, collecteur de reçus et PostgreSQL. Elles utilisent les tags séparés `ddostester-lab-*:linux-amd64`, sans remplacer les images arm64 du cluster kind. Les logs de build sont conservés hors dépôt ; le transfert/import dans le cluster Linux et le bootstrap de ses identités restent à effectuer. Aucun workload applicatif Linux n’est encore annoncé disponible.

## Bootstrap applicatif Linux acquis

Le transfert de l’archive amd64 (263 280 640 octets, SHA-256 `a1756a76cd1ba1e6b6c307acb87b15b5c31589a6a251ecb0032c3d457013fb05`) et l’import ont été vérifiés : noms d’images attendus, digests des manifests/configurations et plateforme Linux amd64. `linux-lab-import.py` publie les alias locaux et les références immuables ; l’agent utilise `docker.io/library/ddostester-lab-control@sha256:3a934511060edc7dfd52ac27ed1c2aeaf7e1059badc19381674ffaaf6c7f0512`. Le contrôle prématuré pendant transfert a refusé l’absence du reçu avant toute importation ; la reprise a eu lieu après fin confirmée de copie.

`lab-identities.py` a généré une CA propre au laboratoire Linux, trois certificats clients et un certificat serveur, vérifiés pour leurs usages TLS. CA privée et credentials restent hors dépôt dans le répertoire d’opération 0700 ; le manifeste de Secrets privé est 0600 et exclut la clé de CA. La CA dure 30 jours et les certificats 14 jours. Les credentials du laboratoire Mac et de production ne sont pas réutilisés.

`linux-lab-bootstrap.py` a installé les ressources dans le namespace réservé, appliqué les Secrets et l’egress nécessaire vers l’API privée, attendu la base et le DNS, créé l’unique propriétaire par le Job de migration puis supprimé ce Job. Le contrôle plane, le service flotte, la cible et la sonde sont Ready sans redémarrage. Une connexion propriétaire réelle a confirmé le rôle admin, l’accès au statut de flotte et les limites effectives **15 RPS / six connexions / 60 secondes**. Prometheus et Grafana natifs restent actifs. Aucune campagne Linux n’a été lancée à cette étape. La recette réseau, la première flotte et les défaillances Linux restent à exercer.

Les scripts de génération, import et bootstrap sont conservés dans `scripts/operations/`. Le rendu des manifests et leur parsing n’exigent pas PyYAML sur le VPS : ils sont sérialisés en JSON avec le parser déjà présent dans les dépendances du dépôt. Les accès opérateur utilisent un kubeconfig distinct et des forwards en loopback, sans sélection du contexte par défaut. Les fichiers privés copiés sur le Mac sont dans `/Users/abdelhatayeb/.local/share/ddostester-linux-lab`, parent 0700 et fichiers 0600. La recette a aussi corrigé l’asymétrie de la politique cible : le contrôle plane, déjà autorisé en egress, peut joindre le HTTP de la cible dédiée, tout en maintenant le refus des pods étrangers. Cette dernière garantie doit encore être recettée sur Linux.

Le générateur reproductible `lab-manifests.mjs` est maintenant dans le dépôt et `js-yaml` 4.3.2 est une dépendance de développement explicite, épinglée. Sa production JSON a été exercée : 28 ressources de fondation et deux déploiements applicatifs ; aucun secret n’est contenu dans ce bundle public de configuration. L’installation a conservé la version déjà présente et l’audit npm retourne zéro vulnérabilité. Le bootstrap a aussi été ajusté pour démarrer le service flotte avant le contrôle plane afin de sérialiser l’initialisation des tables de coordination. Ce dernier ajustement n’a pas encore fait l’objet d’une nouvelle création complète ; la recette applicative précédente a réussi sans redémarrage.

## Premières recettes de flotte Linux

`lab-smoke.py` est ajouté au dépôt : endpoint opérateur loopback, credentials privés, limites de laboratoire vérifiées, cible fixe, flotte 3 RPS/trois connexions et durée explicite 10 ou 30 secondes. Il conserve campagne, résultat et export dans un nouveau répertoire 0700, fichiers 0600. Redirections et proxies d’environnement sont refusés pour ces appels opérateur.

La première fenêtre de 10 secondes (`7bc6190e-340b-4b39-81bc-038479f0dbf7`) s’est terminée sans génération : les trois agents ont atteint le coordinateur après la fenêtre et ont refusé l’affectation. Les logs sont persistés et la mesure est explicitement incomplète. Une erreur de présentation du script sur un résultat absent a été corrigée ; les preuves avaient déjà été conservées.

La fenêtre de 30 secondes (`d61deef7-099a-458b-ab64-877c0792b739`) a produit **58 requêtes et 58 reçus**, avec trois IP privées `10.247.0.16`, `.17`, `.18`. Deux agents ont terminé naturellement ; le troisième a atteint la deadline pendant environ 130 ms de finalisation. Le rapport conserve son état STOPPED et sa confiance dégradée. Le SHA-256 de l’export a été revérifié hors API.

La source réserve désormais les deux secondes de grâce déjà définies pour terminer la génération avant la deadline et finaliser le résultat. Elle ne prolonge ni mission ni bail et n’augmente pas le débit ; la durée configurée reste un maximum, qui inclut le temps de démarrage de la flotte. Un test de finalisation différée avec horloge monotone contrôlée passe, ainsi que les quatre tests d’agent. Le contrôle TypeScript et les sept tests agent/agrégation précédents passent. La nouvelle image et la reprise de la recette Linux restent à effectuer avant de déclarer une mesure complète.

## Construction de la correction de finalisation

La reconstruction amd64 a échoué pendant `npm ci` avec `ERR_SSL_CIPHER_OPERATION_FAILED`. Le même échec a été observé dans un stage natif arm64 du Docker du Mac : l’émulation seule n’explique donc pas cette panne. Aucun contrôle TLS n’a été désactivé. Le Dockerfile compile maintenant sur `BUILDPLATFORM` puis conserve le runtime de la plateforme cible ; un garde après prune refuse les addons et exécutables natifs dans les dépendances de runtime, pour éviter une copie interarchitecture incorrecte.

Un builder Linux temporaire distinct a été créé via un socket Unix privé transmis par SSH, sans exposer de port du daemon Docker ni changer le contexte Docker par défaut. Son image BuildKit est épinglée par digest, sa mémoire vérifiée à 1,5 Gio et son quota CPU à 0,5 CPU. Le build natif a passé `npm ci` et compile l’application ; Prometheus et Grafana restent actifs. La nouvelle image n’est pas encore importée, et la recette corrigée reste à rejouer. L’importeur possède désormais un mode contrôle plane seul qui refuse la mise à jour si des Jobs de flotte sont présents. Sources : [build multiplateforme](https://docs.docker.com/build/building/multi-platform/), [limites du driver conteneur Docker](https://docs.docker.com/build/builders/drivers/docker-container/).

La compilation native et le garde de portabilité ont réussi (108 dépendances de runtime, zéro vulnérabilité npm). L’export vers le Mac a ensuite été interrompu par une erreur d’authentification SSH, reproduite avec un second chiffrement authentifié. Le builder reste running sans OOM ; ses sorties partielles sont isolées et ne sont pas importées. La reprise choisie est un export entièrement local sur le VPS, puis un transfert vérifié de l’archive.

Une archive source vérifiée a été copiée dans le builder. Le lien `CONVENTIONS.md` vers un fichier extérieur a été exclu du contexte de compilation sans modifier le lien du checkout ; l’extraction conserve le filtre de sécurité des archives. Le script `native-lab-export.py`, vérifié avant transfert et présent dans le dépôt, remplace les premiers wrappers qui avaient une erreur d’échappement. L’unité `ddostester-native-export-03.service` est observée active en compilation, avec limites CPU/RAM vérifiées. L’application conserve son image précédente et les recettes Linux corrigées restent à rejouer.

L’export local VPS est désormais terminé : unité `Result=success`, PID nul. L’archive de 69 245 440 octets porte le SHA-256 `16cc223338a0c583cbb33e7728f45651784136f7b153be2a4005dccdf2e2a894`. L’importeur a vérifié le checksum, le nom OCI, les digests manifest/config et la plateforme linux/amd64 avant l’import. Aucun Job de flotte n’était présent. La nouvelle image immutable est `docker.io/library/ddostester-lab-control@sha256:d2adf7c458a7fcc26033c0afc603d5c63e22ff4ea8681703af3e715aff9ef835`. La mise à jour du coordinateur est en cours ; la recette corrigée reste à rejouer. Cette image contient la réserve de finalisation, mais précède les dernières modifications du contexte Kusa.

Le contrôle TypeScript backend et trois tests ciblés passent après réduction du contexte Kusa aux origines HTTP(S) et signaux structurés, et correction du budget des fragments SSE pour compter les octets UTF-8. Le nouveau test fragmente une ligne multioctet de plus de 64 Kio : le flux est interrompu, annulé et ne produit pas de fin réussie. `git diff --check` passe. La validation complète précédente (1 012 tests backend, 395 frontend) précède ces dernières modifications et ne les prouve donc pas à elle seule.

Les rollouts du coordinateur et du contrôle sont terminés avec succès, tous leurs conteneurs étant épinglés au nouveau digest. Le contrôle est observé 2/2 Ready, sans redémarrage, sur `10.247.0.20` ; `FLEET_AGENT_IMAGE` utilise le même digest. Prometheus et Grafana natifs restent actifs. Il s’agit uniquement du laboratoire Linux ; la production conserve son release précédent. La prochaine recette doit rétablir le port-forward sur ce nouveau Pod avant la vérification fonctionnelle.

## Recette Linux avec réserve de finalisation

Le port-forward précédent a effectivement terminé sur perte de son ancien Pod ; il a été rétabli sur le nouveau déploiement après observation de cet état terminal. La recette de 30 secondes `7379fd56-cf2c-4418-98cb-390857679506` est COMPLETED, avec trois shards SUCCEEDED et `measurementComplete=true`. Les **50 requêtes émises correspondent aux 50 reçus cible**, reçus complets, trois sources privées distinctes `10.247.0.21`, `.22`, `.23`. Le checksum SHA-256 du contenu de l’export a été recalculé avec la sérialisation du contrat et correspond. Les preuves sont conservées dans `/private/tmp/ddostester-linux-smoke-settlement-evidence`, fichiers privés. Cela valide la finalisation naturelle de cette recette, sans prouver encore les scénarios de panne Linux.

Le script reproductible `lab-smoke.py` vérifie désormais systématiquement le checksum de l’export avec Node (le contrat utilise `JSON.stringify`, pas une canonicalisation Python). Son option `--require-complete` impose les trois succès, une mesure complète, la concordance des reçus et trois IP distinctes, après conservation des preuves. Cette option n’a pas déclenché une nouvelle campagne dans cette étape ; les assertions équivalentes ont été exécutées sur l’export réel précédent.

R09 : la carte de gestion des comptes propose un filtre accessible tous/actifs/désactivés et explique les profils, le propriétaire unique, la confirmation en single et la révocation des sessions. Le statut historique absent est traité actif, comme le serveur. Les 25 tests d’interaction et single-user passent, dont un parcours de filtrage vérifiant l’absence de mutation de profil/statut. TypeScript frontend, ESLint ciblé, formatage ciblé et `git diff --check` passent. Ces modifications restent dans les sources, hors release de production et hors image Linux construite précédemment.

## R02 — Récupération administrative du propriétaire

La commande `backend/src/cli/recover-owner.ts` et le module transactionnel `owner-recovery.ts` sont ajoutés, avec [procédure opérationnelle](./owner-recovery.md). Le transport exige PostgreSQL et son verrou de runtime exclusif ; une application utilisant la base empêche la récupération. Le mot de passe est lu depuis un fichier régulier privé, propriétaire courant, sans lien symbolique ni argument contenant le secret. La politique persistée doit désigner un compte existant, seul admin. Les autres comptes ne sont pas modifiés. Le propriétaire est réactivé, sa version de session incrémentée et le changement de mot de passe imposé au prochain login. L’audit `user.owner.recovered` contient l’identifiant d’intervention, sans secret ni hash de mot de passe.

TypeScript et build backend passent. Les quatre tests passent, dont une répétition sur base PostgreSQL temporaire distincte, supprimée ensuite : second contrôle refusé par le verrou, compte lecteur préservé, version 7→8, chaîne vérifiée. Le test mémoire prouve aussi le rollback sur panne d’audit et le refus du second admin. Une première assertion PostgreSQL comparait incorrectement les valeurs par défaut persistées à une fixture mémoire ; elle a été corrigée pour comparer l’état PostgreSQL avant/après. La suite est incluse dans `test:postgres` de la CI. Aucun mot de passe ni profil de production n’a changé ; les nouvelles sources restent à promouvoir dans une release validée.

## R09 — Budget et provenance Kusa

Le proxy réserve avant I/O un budget journalier UTC de **50 000 unités par identité et 250 000 globales**, en plus des limites de fréquence/concurrence existantes. Les unités sont les octets UTF-8 du contenu d’entrée, une marge de 64 par message et le cap de sortie `max_tokens`. Il s’agit d’une règle d’admission, pas d’une mesure exacte du tokenizer ni de la facturation. Une réservation n’est pas remboursée après annulation/erreur, afin de conserver une borne prudente. La tarification et les tokens réellement consommés restent null tant que le contrat fournisseur n’est pas confirmé.

Le runtime PostgreSQL crée `assistant_token_budget_v1` et réserve sous verrou transactionnel commun, avec rollback si quota dépassé. Les identités sont stockées comme SHA-256, pseudonymes et non données anonymes ; aucun prompt n’est enregistré dans ce ledger. La journée vient de l’horloge UTC PostgreSQL. L’état survit aux redémarrages. Les tests/developpements sans PostgreSQL utilisent un budget de processus, limité à 1 000 identités et explicitement annoncé comme réinitialisé au redémarrage. Erreur de comptabilité => 503 avant appel fournisseur ; quota dépassé => 429. Les tables de budget sont incluses dans les sauvegardes DB ordinaires ; leur politique de rétention dédiée reste à formaliser.

Un événement SSE `provenance` porte le modèle configuré, le protocole, la réservation et sa persistance ; il ne prouve pas l’identité réelle du modèle exécuté par le fournisseur. L’interface conserve cette provenance avec la réponse et affiche unités réservées / usage et coût indisponibles. Aucun endpoint, clé API ou contexte privé ne figure dans cet événement.

Le gate PostgreSQL complet passe **33 tests**, avec base temporaire supprimée : 20 réservations simultanées de 4 000 unités donnent exactement 12 admissions, le solde persiste via une nouvelle instance et les refus ne gonflent pas le total global. Une première DDL utilisait le mot réservé SQL `window` ; elle a été corrigée en `budget_day` avant le gate réussi. TypeScript API/UI passe ; les trois tests de flux passent, dont refus avant fetch et provenance sans coût inventé. La précédente suite assistant de 17 tests reste verte. Les modifications ne sont pas encore incluses dans l’image Linux ni dans la production.

## Validation intégrée et borne de contention de la sonde

`npm run verify` termine avec succès (log `/private/tmp/ddostester-roadmap-current-verify.log`) : **1 020 tests backend passent, 23 conditionnels sont skipped ; 397 tests frontend passent**, lint, types et builds réussissent. Les tests PostgreSQL réels ont été exécutés séparément avec leur gate obligatoire de 33 tests ; les skips de la suite générique ne les remplacent pas. Les erreurs `useApp used outside provider` du log appartiennent aux tests d’erreur attendus, sans échec de suite. Le build garde l’avertissement de taille de bundle frontend et n’est pas une preuve de promotion/release du checkout encore dirty.

R04 : la sonde autonome possédait une limite de débit, mais aucune borne de mesures en vol. Elle réserve maintenant un slot avant lecture du corps et le libère dans un finally, y compris en cas de refus d’URL. `PROBE_AGENT_MAX_IN_FLIGHT` vaut 2 par défaut et refuse une configuration hors 1–4. Les mesures excédentaires reçoivent 429. Les corps ont une deadline de lecture de deux secondes, les headers/requêtes HTTP cinq secondes et les sockets ouverts sont plafonnés à 64. Le test loopback réel lance quatre mesures lentes simultanées : deux admises, deux refusées, puis vérifie encore redirections interdites, allowlist et réponse trop volumineuse. Il passe après le changement ; le verify complet précédent n’est pas utilisé seul pour prouver cette nouvelle borne. La mesure CPU/throttling/event-loop de la sonde reste à implémenter, et les images des laboratoires doivent être reconstruites pour prendre cette modification.

## R04 — Diagnostic de ressources de la sonde

La source ajoute désormais `ddostester.probe.quality/v1` à chaque réponse authentifiée de mesure : CPU utilisateur/système du processus, RSS, elapsed monotone, délai maximal de boucle événementielle (résolution 20 ms), delta `throttled_usec` cgroup v2 et timestamp de provenance. Absence de cgroup, compteur décroissant ou histogramme sans échantillon => null. Le champ scope précise que la fenêtre décrit le processus pendant la mesure ; des mesures concurrentes partagent cette comptabilité, les deltas CPU ne doivent pas être sommés comme des coûts indépendants. Le cgroup peut couvrir d’autres processus du même groupe. Le timestamp de la sonde n’est pas une preuve de synchronisation d’horloge.

Le backend accepte les réponses historiques sans diagnostic et valide strictement les valeurs présentes, bornes et schéma. Il conserve dans `run.probe.quality` la couverture, les pics et le dernier diagnostic ; l’export flotte réutilise ce même objet. Une couverture inférieure à 90%, des compteurs indisponibles, un délai de boucle >100 ms ou du throttling >10% de l’intervalle dégradent explicitement la confiance. Aucun score cible ni kill threshold n’est corrigé par ces diagnostics.

TypeScript backend, ESLint ciblé et les 12 tests sonde/transport/qualité passent. Le test du processus autonome vérifie réellement les champs CPU/RSS ; les tests de schéma refusent les valeurs négatives/non finies et conservent les nulls. Un test de sonde distante vérifie aussi que les agrégats et le dernier relevé proviennent bien des réponses du transport. Les nouvelles images et leur recette Linux restent à construire ; le succès précédent de 50 requêtes concerne l’ancienne image de sonde et ne valide pas ces nouveaux diagnostics.

## Sonde diagnostique déployée sur le laboratoire Mac

L’installation native documentée copie désormais aussi `quality.mjs`, nécessaire au démarrage. Le serveur refuse des paramètres dépassant son enveloppe : timeout 60 s, débit 20 mesures/s, concurrence 1–4, corps capturé 32 Kio, réponse 1 Mio et port valide. Deux tests du processus autonome passent, dont quatre configurations hors enveloppe refusées avant bind. Le chronométrage TTFB commence après la lecture initiale du compteur diagnostic.

La construction arm64 de `ddostester-lab-probe:quality` réussit sans dépendances téléchargées via npm. Index OCI `sha256:0ac2ffba971faf578894ae30944f09921704cd0ea3a5478dc6c305eca9165758`, manifest arm64 `sha256:d39fb5d78f5e8f864745b6a4bfc61d6afe09149df4a3d6921f3d15ef3575758a`. L’image est importée dans le seul cluster kind `ddostester-lab` ; aucun Job de flotte n’était présent. Le rollout de `lab-probe` termine avec succès.

Une mesure authentifiée depuis le Pod contrôle vers `http://lab-target:8080/health` renvoie HTTP 200 et `ddostester.probe.quality/v1` : elapsed 18,789 ms, CPU utilisateur 14 948 µs, système 3 995 µs, RSS 67 305 472 octets, delta throttled 0. Le délai de boucle est null : aucun échantillon de 20 ms n’a été pris dans cette courte fenêtre. Cela confirme la différence entre inconnu et compteur nul. Cette vérification n’a lancé aucune campagne et ne prouve pas encore une recette complète avec le backend reconstruit ou sur Linux. Production inchangée.

Après disparition de l’ancien Pod en terminaison, le nouveau Pod `lab-probe-65d85575d4-rrl7p` est seul et Ready, UID `84ecbd0c-cdc7-42d7-a0e2-8d184832125e`, IP privée `10.246.111.190`. Son imageID runtime est `docker.io/library/import-2026-10-13@sha256:59cbd703fbdedb589caf88bfbf84ec100587d57844fb0a898ecd642a3fc907fc` ; cet identifiant après import kind est conservé séparément des digests de construction OCI, sans les assimiler.

## Cohérence des diagnostics dans les rapports

Le bilan frontend affiche désormais couverture et diagnostic de sonde : délai maximal, fraction de throttling et CPU/RSS du dernier relevé, avec scope de processus et avertissement sur les mesures concurrentes. Les valeurs nulles affichent « unknown » ; le compteur nul affiche 0 %. Le test d’interface et TypeScript frontend passent.

Le rapport HTML reprend couverture, pics et scope depuis `run.probe.quality`, avec échappement des champs. Le CSV ajoute trois colonnes en fin de schéma : `probeDiagnosticSamples`, `probeEventLoopDelayPeakMs`, `probeThrottledFractionPeak` ; inconnus en cellule vide, compteur nul conservé à zéro. Les consommateurs du CSV doivent accepter ces nouvelles colonnes. TypeScript backend et les 11 tests préexistants rapports/CSV passent ; un test supplémentaire vérifie la distinction inconnu/zéro dans les deux exports.

Le verify complet lancé après le diagnostic de sonde termine avec succès : **1 024 tests backend, 398 frontend**, 23 conditionnels skipped, lint/types/builds réussis. Les ajouts de présentation/export de cette étape ont aussi leurs contrôles ciblés ; le verify lancé avant leur finalisation ne remplace pas ces contrôles. Le log est `/private/tmp/ddostester-roadmap-probe-quality-verify.log`. Les images du contrôle et Linux ne contiennent pas encore toutes ces sources, et la production conserve sa release antérieure.

## Promotion de la sonde diagnostique Linux

La sonde amd64 est construite et exportée dans une archive de 60 730 368 octets, SHA-256 `f1c8353e5d3a43273540785e6b5f235ea7baad49b12c421ac9fb205b5960ffd0`, transférée dans le répertoire privé du laboratoire Linux. Le nouvel importeur `--probe-only`, exclusif de `--control-only`, refuse tout Job de flotte présent et tout nom d’image hors sonde attendue. Il vérifie le checksum et supporte maintenant l’index OCI imbriqué de Docker : exactement un runtime linux/amd64, seules les attestations marquées unknown/unknown admises à côté, digests de metadata vérifiés. Le SHA de l’archive protège tous les blobs ; cette vérification ne constitue pas une validation cryptographique de l’attestation.

L’import réussit et conserve une preuve séparée `probe-update-f1c8353e5d3a.json`, sans remplacer le reçu initial ni l’image du contrôle. Image sonde immutable `docker.io/library/ddostester-lab-probe@sha256:13c48bc25ba2d5c063ee37dc17a59578f102569641ca5b587bf68835b2f63d5e`. Son rollout est lancé ; la vérification fonctionnelle Linux reste à effectuer avant d’annoncer la recette.

Le rollout termine avec succès. Le nouveau Pod `lab-probe-7cf65499b-vlqp8` est 1/1 Ready, sans restart, IP `10.247.0.24` ; l’ancien Pod est encore observé en terminaison. Une mesure authentifiée depuis le contrôle vers la cible privée retourne HTTP 200 avec le schéma diagnostique attendu : elapsed 474,164 ms, CPU user 75 254 µs / système 47 674 µs, RSS 67 170 304 octets, délai de boucle max 97,321 ms, throttled 324 088 µs. Le throttling représente environ 68% de l’intervalle avec la limite CPU actuelle de 250m. Cette observation de démarrage indique une contention locale potentielle ; elle ne prouve ni une panne cible, ni un régime permanent. Elle dépasse le seuil diagnostique prévu de 10%, ce qui justifie une confiance dégradée si observée dans une campagne avec le nouveau backend. Aucun cap de charge ni allocation CPU n’a été augmenté pour masquer cette mesure. Prometheus et Grafana restent actifs. Le contrôle Linux doit encore être reconstruit pour enregistrer ces diagnostics dans les runs.

## Reconstruction identifiée du contrôle Linux

Un nouveau snapshot des fichiers Git suivis et non ignorés est conservé hors checkout, sans les liens symboliques ni `.DS_Store`. Aucun commit, index, branche ou fichier local existant n’est remplacé. Archive source 1 752 218 octets, SHA-256 `f30b61180d64658e0c66d532de5f9b236f27822ec121a42b74ec17233f8f9aa1`, HEAD de référence `d98db08ecb520b4021df645e7aded44fe38ad939`. Ce snapshot inclut les derniers diagnostics, rapports, récupération propriétaire et budgets Kusa ; des modifications documentaires postérieures n’en font pas partie.

Le script de build accepte désormais un répertoire source borné et un checksum identifié. Il inscrit `snapshot:<SHA-256>` dans la référence de build et conserve le checksum source dans le reçu d’export. Le snapshot transféré est vérifié avant extraction avec filtre data, puis copié dans un nouveau répertoire du builder. Les anciens contextes et archives sont conservés.

L’unité `ddostester-native-export-04.service` est vérifiée activement en cours (`MainPID=576625`, activating/start), dans l’étape `npm ci --ignore-scripts`. Builder toujours running sans OOM, mémoire 1,5 Gio / quota CPU 0,5 vérifiés avant lancement ; Prometheus/Grafana restent actifs. La commande de lancement peut attendre la fin de l’unité oneshot : son attente ne justifie pas un second lancement. L’export et sa recette restent à vérifier ; l’application Linux conserve son image précédente pendant ce build.

## R01 — Capture reproductible des sources

Un outil réutilisable `source-snapshot.py` remplace la capture manuelle pour les prochains builds : archive et reçu privés créés exclusivement hors checkout, manifeste par fichier, métadonnées normalisées, budgets de taille et refus de changement de sources/HEAD/inventaire pendant capture. Il ne touche ni index ni branche. [Procédure](./source-snapshots.md) liée au runbook. Deux captures successives de 565 fichiers produisent des archives byte-identiques ; une vérification séparée recalcule archive, manifeste et les 565 checksums/modes. Après ajout du contrôle d’inventaire, la seconde paire porte le SHA `9abf30d6a3f1d58c9b9404b53338890bb050a4402943f66b01fe0471c0c27cb2`, manifeste `2a6d6c52e11e5bf50b3828d2a05d934c42ee594e8981c4899c36bf7f84457853`, taille 1 756 358 octets. Les archives de preuve restent dans `/private/tmp/ddostester-source-snapshot-proof` privé.

Le build export-04 a progressé de npm ci à la compilation TypeScript API/UI ; son PID principal reste 576625 et l’unité activating/start. Ce build utilise son snapshot source `f30b…f9aa1` précédent : il ne contient pas le nouvel outil de capture ni les ajouts documentaires de cette étape. Aucun second build n’a été lancé. R01 n’est pas déclaré entièrement passé : revue Git/PR et promotion produit restent nécessaires.

Le vérificateur réutilisable `verify-source-snapshot.py` est ajouté et lié à la procédure. Il ne décompresse pas les fichiers sur disque et n’exécute rien : checksum global, identité HEAD/schéma, checksum du manifeste, inventaire exact sans doublon, chemins normalisés, fichiers réguliers seulement, modes/tailles/checksums de chaque source. Les budgets sont contrôlés pendant la lecture des membres (10 000 entrées, 16 Mio/fichier, 256 Mio total), avant de suivre une entrée surdimensionnée. Il valide les 565 fichiers de la capture réelle. Deux recettes négatives refusent l’archive altérée et un fichier source altéré même après recalcul du checksum global dans le reçu. Le reçu reste une référence de confiance administrative, sans signature d’authenticité.

Le build export-04 est toujours observé avec PID principal 576625, unité activating/start. L’API a fini sa compilation et porte la référence complète du snapshot ; le frontend est dans `tsc -b && vite build`. Aucune nouvelle compilation n’est lancée sur une absence de nouvelle ligne de log.

## Rétention du registre de budgets Kusa

Les nouvelles sources suppriment les fenêtres de réservation antérieures à la date UTC PostgreSQL moins 90 jours, au démarrage puis toutes les 24 heures. Seule `assistant_token_budget_v1` est concernée ; comptes, audit et réservations courantes sont conservés. Une erreur de nettoyage est journalisée, sans remise à zéro du budget. Le timer est arrêté à la fermeture avant celle du pool. Cela borne l’historique du registre opérationnel ; la rétention des archives chiffrées de sauvegarde reste un sujet séparé.

Les trois tests de budget passent avec PostgreSQL réel, dont insertion d’une fenêtre expirée puis contrôle de sa suppression et du maintien des 50 000 unités courantes. TypeScript backend passe. Cette rétention a été ajoutée après le snapshot export-04 et ne fait pas partie de l’image actuellement en construction.

Le build export-04 a terminé la compilation API/UI, le manifeste de release et la purge des dépendances de développement. Les 108 dépendances runtime sont auditées sans vulnérabilité ; le garde ne trouve aucun addon/exécutable natif. PID principal 576625 encore actif au dernier contrôle, export non déclaré terminé avant vérification de l’unité et du reçu.

L’export-04 est désormais terminé : `MainPID=0`, unité active/exited, `Result=success`. Archive 69 253 632 octets, SHA-256 `f06b1a427e94f43420d3afba459efc82f2e62c36dced1cc0c80970d32806d90c`, reçu portant le checksum source complet `f30b61180d64658e0c66d532de5f9b236f27822ec121a42b74ec17233f8f9aa1`. Le processus de lancement initial a terminé normalement, sans second lancement. L’import contrôle-seul réussit après vérification archive, manifest/config, linux/amd64 et absence de Jobs. Image immutable `docker.io/library/ddostester-lab-control@sha256:33d1162c596f01ef9d6ae3e19003baa5c7b5a0eccbf2eae407dc78b5963fd446`, preuve `control-update-f06b1a427e94.json` conservée séparément. Elle n’est pas encore promue dans les déploiements du contrôle/coordinateur : vérification API/UI et recette restent nécessaires. Les anciennes images immutables et la production sont préservées.

## Promotion du contrôle identifié dans le laboratoire Linux

Après confirmation de l’absence de Jobs de flotte, le coordinateur est promu et son rollout réussit. Le contrôle est ensuite modifié par une seule mise à jour du template : conteneur API, proxy loopback et `FLEET_AGENT_IMAGE` pointent tous sur le digest `33d116…fd446`. Son rollout réussit ; Pod `lab-control-69cf797866-h4lzr`, IP privée `10.247.0.26`, 2/2 Ready, aucun restart observé.

Le vérificateur de release du dépôt est exécuté dans le Pod via le proxy loopback. Il confirme `/ready`, la référence API exacte `snapshot:f30b61180d64658e0c66d532de5f9b236f27822ec121a42b74ec17233f8f9aa1` build lab et les SHA-256 de tous les assets UI du manifeste. La table de budgets Kusa est vérifiée présente via une requête de lecture sans imprimer la configuration DB. Cette image inclut les diagnostics de sonde et rapports, la récupération propriétaire et la réservation Kusa ; elle n’inclut pas la rétention Kusa ni les scripts de capture ajoutés après son snapshot. Les recettes authentifiées/fautes restent à exécuter sur cette image. Production et images précédentes inchangées.

## Recette authentifiée du contrôle identifié et dossier infrastructure

Le précédent port-forward a effectivement terminé sur perte de son ancien Pod ; il est rétabli sur le nouveau contrôle après observation de son état terminal. `lab-smoke.py --duration 30 --require-complete` réussit avec les credentials privés du propriétaire : run `d4819dcb-fcdd-4a91-b856-77827131788f`, trois SUCCEEDED, mesure complète, **54 requêtes / 54 reçus cible**, trois IP privées 10.247.0.27/.28/.29. Le script vérifie le checksum et conserve campagne/run/export dans `/private/tmp/ddostester-linux-current-quality-evidence` privé.

Le résultat porte 29/29 diagnostics de sonde, dernier RSS 76 021 760 octets, throttling maximal 0, délai de boucle maximal null faute d’échantillon sur les fenêtres courtes. La confiance est donc explicitement dégradée pour ressource partiellement inconnue ; aucune valeur absente n’est convertie en compteur nul. Trois snapshots de Job sont dans l’export. Cela valide la chaîne diagnostique réelle jusqu’au run et à son export, sans prouver encore arrêt sous panne, collecte Prometheus lab ou parcours navigateur complet.

Le [dossier infrastructure](./infrastructure-handoff.md) est créé : architecture/références, matrice de flux, RBAC/admissions, identités, budgets/arrêt, preuves et runbooks, dépendances externes. Il distingue le test de compatibilité sur le VPS monitoring du futur VPS dédié R10 et conserve G4 non validé. Aucun raccordement au cluster équipe ni campagne publique n’a été lancé.

## Recette d’arrêt manuel Linux

Le script réutilisable `lab-stop-check.py` prépare une campagne fixe de 30 s, 3 RPS/trois connexions, attend les trois sources privées dans les logs de la cible et envoie l’arrêt manuel. Il ne se fonde pas sur la synchronisation Mac/VPS : l’ancre vient du Pod cible avant dispatch, donc mesure une borne conservatrice. Une seconde paire wall/monotone contrôle la dérive ; neuf secondes de reçus sont observées après settlement. Contextes Kubernetes et API opérateur sont bornés aux laboratoires loopback ; secrets et preuves restent privés.

Le run Linux `aed36b5e-5a0a-4132-b946-beaa762acee3` termine KILLED_MANUAL, trois STOPPED, trois sources corroborées. Dernière nouvelle requête **1 862 ms** après l’ancre cible avant dispatch, dérive wall/monotone 0 ms. La limite de huit secondes passe pour cette recette. Ancres, ack, résultat, reçus, export et preuve sont conservés dans `/private/tmp/ddostester-linux-manual-stop-current`. Le checksum de l’export est revérifié séparément ; la version du script inclut aussi cette vérification pour les prochaines recettes. Le résultat arrêté reste une mesure interrompue, pas une campagne naturellement complète. Crash contrôle/coordinateur et partitions réseau restent à vérifier sur Linux.

## R06 — Révocation de feuille mTLS

Les sources ajoutent une liste bornée `FLEET_REVOKED_CERT_SHA256`, fingerprints SHA-256 du DER, 64 hex sans séparateurs, max 128 entrées. Malformation => refus de démarrage. Chaque route agent vérifie la feuille avant claim/heartbeat/result ; l’ancienne feuille peut donc être refusée sans bloquer le CN d’une feuille renouvelée. La liste est chargée au démarrage, pas en hot reload ; le refus est applicatif 403 après validation de chaîne TLS, pas une CRL système.

TypeScript et les quatre tests mTLS réels loopback passent : absence de certificat, identité non inscrite, identité autorisée et rotation ancien/nouveau CN identique. L’ancien reçoit 403, le nouveau 200 ; un seul appel atteint le coordinateur. [Runbook certificats](./fleet-certificates.md) ajouté, avec rotation planifiée hors campagne et règle de non-rejeu des missions perdues. Aucun Secret de laboratoire n’a été remplacé pendant cette étape ; images et recette Linux de révocation restent à effectuer.

## Recette Linux de perte du coordinateur

Le cinquième test mTLS passe : configuration de révocation malformée ou dépassant 128 entrées refusée avant ouverture TLS. La recette `lab-stop-check.py` ajoute le mode explicite `coordinator-outage`, limité aux contextes lab et endpoints loopback. Elle attend trois sources privées actives, capture l’ancre cible, réduit uniquement `lab-fleet` de un à zéro replica et restaure un replica en finally, avec rollout contrôlé. Elle conserve les résultats incomplets au lieu d’inventer des acquittements d’arrêt.

Le run `c02d7aea-f30e-4b20-bfd9-87444bdf1330` vérifie trois sources et la dernière nouvelle requête **3 346 ms** après l’ancre cible avant dispatch, dérive wall/monotone **1 ms**. Trois shards LOST, mesure incomplète et confiance dégradée. Le coordinateur est restauré Ready ; aucun retry de mission n’a été ajouté. Preuves privées dans `/private/tmp/ddostester-linux-coordinator-outage-current`, checksum de l’export vérifié par le script. Les compteurs finaux émis sont inconnus pour ces agents perdus ; les reçus cible constituent leur preuve indépendante de génération et d’arrêt, sans reconstruire artificiellement des résultats agents. Crash du contrôle et partitions CNI restent ouverts.

## Changement de NetworkPolicy : recette non concluante de partition

Le mode `policy-removal` vérifie la spécification exacte de `agent-coordinator`, sauvegarde la politique puis retire uniquement cette autorisation egress 8443. Le coordinateur reste actif. Le run observé termine trois SUCCEEDED, mesure complète : ce changement n’a pas démontré de coupure effective de communication. Ce résultat ne valide pas l’arrêt sous partition et n’est pas présenté comme une défaillance de lease. La [documentation officielle Kubernetes](https://kubernetes.io/docs/concepts/services-networking/network-policies/) indique que l’effet d’un changement de politique sur les connexions existantes dépend de l’implémentation. Des connexions persistantes constituent une explication possible ; l’enforcement sur nouvelles connexions doit aussi être vérifié avant conclusion.

La restauration dans le finally a rencontré une panne du tunnel API SSH (`message authentication code incorrect`, tunnel terminé). La règle est restaurée après revalidation de cette terminaison et réouverture du même tunnel, avec contrôle d’égalité de sa spec sauvegardée. Preuves dans `/private/tmp/ddostester-linux-policy-removal-current`, dont `policy-restored.json`. Aucun reset ou second lancement de campagne n’a été utilisé comme récupération. Le script conserve désormais les reçus avant restauration et épingle l’API loopback IPv4 pour les kubeconfigs localhost, sans désactiver TLS ou la validation des manifests. Un rollback autonome sur l’hôte doit être préparé avant la prochaine injection réseau, afin que sa restauration ne dépende pas du réseau du Mac. Cette recette reste non validée ; partition effective et crash du contrôle restent ouverts.

## Restauration réseau autonome sur l’hôte Linux

`linux-policy-rollback.py` est ajouté et installé sur le VPS lab. Il exige root, le répertoire d’opération privé, le nodeId de la preuve de création et le label de nœud isolé. Il ne peut restaurer que `agent-coordinator` dans `ddostester-lab`, avec sa spec bornée vers `lab-fleet` TCP 8443. Une politique existante divergente est conservée sans overwrite. Le timer systemd est vérifié active/waiting avant que l’armement soit annoncé ; la restauration utilise directement le kubectl du nœud Docker, sans tunnel du Mac. Un reçu privé distinct porte nodeId et UID de politique restaurée.

Recette réelle sans campagne : timer `ddostester-policy-rollback-dd0b59b464d2` observé active/waiting, retrait de la seule politique, restauration automatique par l’hôte à l’échéance de 30 s. Service `Result=success`, journal `restored=true, created=true`, UID `079f0333-c7b7-4cba-abd3-809c4f9e595c`. La politique est de nouveau présente et vérifiée. Aucun débit cible n’a été produit dans cette recette de restauration.

Le mode `policy-removal` de la recette exige désormais le contexte Linux et `--ssh-key` privé ; il arme et conserve le reçu du rollback hôte de 60 s avant toute suppression. Le finally local reste un second chemin de restauration. Cette intégration n’a pas déclenché une nouvelle campagne dans cette étape. La partition effective et les tests de nouvelles connexions CNI restent ouverts ; le succès de restauration n’est pas assimilé à leur validation.

## CNI Linux — nouvelles connexions effectivement filtrées

`linux-cni-check.py` est ajouté : contexte lab identifié, image contrôle immutable, absence de Jobs de flotte, Pod non-root/read-only sans Secret/SA, deadline 120 s, tests de connexions TCP uniquement vers services privés. Aucun payload HTTP, campagne ou destination publique. Les services interdits sont d’abord vérifiés disponibles depuis le contrôle, pour distinguer absence de service et filtrage.

Deux recettes réelles passent. Depuis le Pod d’agent synthétique, cible 8080 et coordinateur 8443 sont accessibles ; PostgreSQL 5432 et sonde 8099 refusent les connexions (`ECONNREFUSED`), avec résolution DNS vers leurs ServiceIPs privées. Après retrait de `agent-coordinator`, une nouvelle connexion au coordinateur est refusée et la cible reste accessible. Le rollback hôte est armé et vérifié avant retrait ; la règle est restaurée dans un finally. La seconde recette vérifie aussi le retour des connexions cible/coordinateur après restauration, et tente le nettoyage du Pod même si restauration échoue. Les preuves sont dans `/private/tmp/ddostester-linux-cni-fresh-proof` et `…-02`, privés. Le nettoyage est désormais attendu explicitement, pas simplement demandé en arrière-plan.

Ce résultat confirme l’enforcement des flux testés sur nouvelles connexions du CNI Linux. Il ne prouve ni filtrage de toutes destinations/namespace/host-network, ni coupure de connexions existantes. La recette de partition complète reste ouverte ; le run naturel après changement de policy précédent est compatible avec des connexions conservées. Aucun résultat ne redéfinit G1/G2 comme entièrement passés.

## R08 — Portée des compteurs lors de perte d’agents

La recette de perte du coordinateur a confirmé du trafic dans les reçus cible alors que les trois résultats finaux d’agents manquaient. Les agrégats reçus ne doivent donc pas être lus comme zéro trafic global. Les nouvelles sources conservent `fleet.counterCoverage` : nombre de rapports finaux reçus/agents attendus et scope `received-final-results-only`. Le calcul des compteurs reste la somme des rapports reçus ; aucun résultat perdu n’est inventé et les reçus cible restent indépendants. Les exports historiques infèrent cette couverture à partir de leurs shards.

Le bilan UI et le rapport HTML qualifient les compteurs partiels ; sans aucun résultat final, requêtes/débit/outcomes/latence rapportés affichent unknown. Les fractions de succès/échec sont aussi qualifiées selon les rapports reçus, sans conclusion sur les agents absents. Le CSV laisse les agrégats globaux inconnus en cellule vide et ajoute les colonnes de couverture, `reportedRequests` et scope ; les consommateurs doivent accepter ces colonnes additionnelles. L’export JSON flotte conserve la couverture explicitement.

TypeScript API/UI passe, 16 tests backend ciblés rapports/agrégation/export passent et 15 tests UI ciblés passent. Les nouveaux cas vérifient la distinction absence de résultat/zéro et le CSV avec champs globaux vides, compteurs reçus séparés. Ces changements sont dans les sources, hors image Linux actuelle ; la recette de perte de coordinateur reste la preuve d’origine, sans prétendre avoir reçu des compteurs finaux après coup.

## Kusa — Dernière mesure et statut inconclusif

Le contexte Kusa ne reprend plus le WRS caché de campagne sans examiner son dernier run. Un résumé pur retient les mesures interrompues, flottes incomplètes, confiance dégradée ou verdict inconclusif comme tels, avec WRS withheld. Absence de preuve ou date de run invalide => pas de score transmis. Les scores estimés sont identifiés comme estimés ; valeurs non finies/hors 0–100 refusées. Les origines expurgées sont conservées et aucun nom libre de campagne/raison libre/URL sensible n’est ajouté.

L’inspection a révélé que le store mémoire retournait l’ordre d’insertion malgré le contrat newest-first, tandis que PostgreSQL trie par enregistrement. Le store mémoire est corrigé, avec un test de contrat commun vérifiant nouveau run avant ancien et ordre inchangé lors d’une mise à jour. Kusa choisit en outre le dernier run de campagne explicitement par sa date de mesure, sans dépendre de l’ordre des stores ; une date inconnue empêche une inférence de score fiable.

Les trois tests ciblés contexte passent ; TypeScript backend passe. Le gate PostgreSQL complet passe **35 tests**, contrat mémoire/PostgreSQL inclus. Une validation complète est lancée dans `/private/tmp/ddostester-roadmap-counter-context-verify.log` pour les changements de présentation/ordre/contexte récents ; elle reste en cours à cette étape. Aucune image en service ni compte de production n’a été modifié.

Le premier gate complet termine en échec sur la nouvelle assertion WRS hors plage (1 échec, 1 031 tests passés). Le test a été enrichi pendant l’exécution du gate et le test ciblé relancé après modification passe. Ce gate ne valide donc pas le snapshot courant. Après observation de son exit 1, un nouveau gate complet est lancé sur les sources figées, log `…counter-context-verify-02.log`. Aucun gate encore actif n’a été dupliqué, aucune promotion n’est fondée sur le premier résultat.

Le second gate complet termine avec exit 0 : **1 032 tests backend passent, 24 conditionnels skipped, 399 frontend passent**, lint, types et builds réussis. Le gate PostgreSQL réel séparé de 35 tests complète la suite générique. Le warning de taille de bundle frontend demeure, sans échec. Les compteurs partiels, contexte Kusa et ordre de store sont ainsi vérifiés ensemble sur ce code ; leur promotion dans une nouvelle image reste à effectuer.

Le laboratoire Linux est observé avec contrôle, coordinateur et sonde chacun Ready 1/1. Le helper `linux-control-crash.py` est ajouté et transféré pour préparer la prochaine recette : root/répertoire privé, nodeId et label du nœud isolé, exactement un Pod contrôle actif, conteneur control Ready, PID strictement supérieur à un et cmdline exacte du serveur avant signal KILL. Il ne cible ni le nœud Docker, ni ses autres conteneurs, ni les services natifs. Sa syntaxe est vérifiée ; aucune campagne ni injection de crash n’a été exécutée dans cette étape. La recette doit encore enregistrer l’arrêt cible, la reprise et l’absence de replay.

## Crash réel du contrôle Linux et reprise sans replay

Le premier lancement échoue avant création de campagne parce que le port-forward API opérateur est terminé ; son handle est vérifié terminal avant réouverture. La recette suivante provoque bien un restart du conteneur control et une annulation de campagne, mais sa borne conservatrice depuis l’ancre cible avant préparation SSH est 9 360 ms. Elle n’est pas déclarée réussie sur l’objectif de huit secondes. Trois Jobs terminés et leurs logs sont conservés avant nettoyage, sans rejouer cette mission.

Le helper capture maintenant l’horloge hôte juste avant signal KILL, après les contrôles de PID/cmdline. Une nouvelle campagne gouvernée distincte vérifie cette ancre contre les paires wall/monotone de la cible, ajoute l’écart d’horloge à la borne mesurée et conserve le seuil de huit secondes. Résultat : **5 902 ms**, compatibilité d’horloge **0 ms**, dérive **0 ms**, trois sources privées. Campagne CANCELLED, parent de flotte STOPPING, contrôle Ready avec restartCount 2. La requête execute est interrompue comme attendu ; aucune charge n’est relancée automatiquement. Preuves dans `/private/tmp/ddostester-linux-control-crash-current-03`, incluant trois Jobs et logs conservés avant nettoyage.

La recette révèle un écart réel de restitution : `saveRun` n’est appelé qu’après settlement, donc aucun rapport CampaignRun final n’existe après ce crash. Les états durable de flotte, données d’agents et reçus cible existent, mais un rapport interrompu/restauration de preuve doit être ajouté. Cette absence reste ouverte en R07/R08 ; aucune donnée de score ou compteurs finaux n’est inventée pour la masquer. L’arrêt et la reprise sont validés pour cette recette, pas l’intégralité de la récupération produit.

## R08 — Export du coordinateur après interruption du contrôle

Une nouvelle route protégée `GET /api/fleet/runs/:runId/evidence.json` restitue un snapshot durable directement des tables de coordination, via un unique SELECT borné à trois shards, sans expiration/réassignation/renouvellement. Schéma `ddostester.fleet.persisted-evidence/v1`, no-store et attachment ; identité invalide 400, run inconnu 404, store non disponible 503 avec message sans détail de configuration. La permission campagne:read reste requise.

Le snapshot conserve parent/campaign/run, état, deadline/bail, tentatives/hashes, budgets, séquences/progrès et mesures finales reçues. Leur couverture est explicite. Il ne se prétend pas un rapport CampaignRun final : sonde, baseline, reçus target historiques et WRS restent null, avec limites de provenance. Le checksum détecte l’altération mais n’authentifie pas l’exporteur. Les métriques de générateur sont désormais sélectionnées explicitement dans les exports ordinaires et durables, afin de ne pas laisser passer de propriétés supplémentaires contenant config/secret par spread.

TypeScript et deux tests HTTP/expurgation passent. Le gate PostgreSQL réel complet passe **36 tests**, dont lecture d’un parent STOPPING, absence explicite de données perdues, checksum, aucun changement d’état/bail et run inconnu. Un champ de secret inattendu injecté dans une fixture générateur est absent de l’export. Le contrat HTTP vérifie refus non authentifié et identité invalide no-store. ESLint ciblé et diff-check passent.

Cette restitution est dans les sources et n’est pas encore disponible dans l’image Linux f30b ; promotion, collecte du crash réel via la route et découverte dans l’interface restent nécessaires. Elle ne ferme pas à elle seule le manque de rapport interrompu signalé par la recette précédente.

L’expurgation est complétée pour les ressources d’agents : schéma attendu et seuls compteurs numériques connus sont exportés ; champs supplémentaires ignorés, valeurs invalides/inconnues nulles. Le champ `isFinalizedCampaignReport=false` décrit explicitement la nature de cet export, sans affirmer qu’aucun rapport normal ne pourrait exister ailleurs pour le même run.

Le test PostgreSQL inclut maintenant un résultat STOPPED déjà persisté : compteur de deux requêtes conservé, couverture 1/3, transport/config et champs supplémentaires contenant un canari de secret absents, CPU invalide null. Les **36 tests du gate PostgreSQL passent**, avec TypeScript et ESLint ciblé. Les déploiements et l’interface n’ont pas encore changé pour cette fonctionnalité.

## Découverte des preuves enregistrées depuis une campagne

Une route protégée par campaign:read retrouve le dernier snapshot de coordination d’une campagne : `GET /api/fleet/campaigns/:campaignId/evidence.json`, no-store, 400/404/503 explicites. Le lookup reste paramétré et read-only, puis réutilise l’export expurgé. Le test PostgreSQL vérifie que ce lookup retrouve le run attendu ; le gate de 36 tests passe.

Le drawer d’une campagne fleet CANCELLED sans rapport final propose désormais « Read recorded evidence », puis les états, sources privées et compteurs reçus, avec inconnus explicites et WRS unavailable. Un bouton télécharge le même objet JSON/checksum. Le texte ne suppose pas que toute campagne annulée a subi un crash : il explique l’absence de rapport final et les preuves potentiellement disponibles. La raison de cancellation est affichée lorsqu’elle existe. Les snapshots restent clairement distincts d’un rapport final et d’une preuve d’arrêt.

TypeScript API/UI, 15 tests frontend ciblés et le test HTTP d’auth/identifiants invalides passent, avec ESLint et diff-check. Le nouveau test vérifie lecture uniquement après clic et résultats perdus inconnus. Les routes et écran restent à promouvoir dans les images et à vérifier sur les données du crash réel ; la restitution n’est pas encore déclarée validée de bout en bout.

## Gate intégré, conservation durable et image source-05

Le gate complet `/private/tmp/ddostester-roadmap-durable-evidence-verify.log` termine avec exit 0 : **1 032 backend passent, 25 conditionnels skipped, 400 frontend passent**, lint/types/builds réussis. Le gate PostgreSQL réel séparé de 36 tests reste la preuve des fonctionnalités DB non exécutées dans la suite générique.

Neuf dossiers de recettes sont copiés, sans supprimer leurs originaux, dans `/Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-recipes-with-checksums` : dossiers 0700, fichiers 0600, manifeste SHA-256 de **69 fichiers** revérifiés. Cette conservation inclut les recettes réussies et les essais non concluants/échoués, dont leurs statuts restent ceux du journal ; un checksum valide ne signifie pas une recette réussie.

Le snapshot source-05 capture **576 fichiers**, archive 1 784 511 octets, SHA-256 `de20b8c861845af3caf2010e40c7dd0d1acbf75f3a28efb66afd9a31c4c4c57e`, manifeste `7bbb33de8d62922eaaff4ebb70dd5e875e25459a87e8e6c1b92c4cf08deae871`. Archive/manifeste/fichiers sont vérifiés sur Mac puis après transfert sur VPS, avant copie dans un nouveau contexte builder. Les sources et images précédentes sont préservées.

L’unité `ddostester-native-export-05.service` est lancée une fois, sans bloquer sur sa durée complète. Son PID **607301** est observé activating/start à `npm ci --ignore-scripts`. Builder running sans OOM, limites 1,5 Gio / 0,5 CPU vérifiées. L’application Linux conserve l’image f30b et la production sa release antérieure. La nouvelle image doit encore terminer, être importée/promue et faire l’objet de la recette API/UI/navigateur sur les preuves du crash conservées.

## Recette Chrome du panneau de preuves récupérées

Un harness temporaire charge le vrai composant et CSS, avec réponse API de recette expurgée. Chrome headless installé est testé à **360 et 1 280 px** : lecture via focus/Enter, affiche couverture 1/2 et agent perdu unknown, téléchargement JSON identique au contenu/checksum attendus, aucun débordement horizontal et aucune erreur de page. La capture mobile est inspectée visuellement : texte, sources et boutons restent lisibles et complets. Fichiers de recette et captures sont privés dans `/private/tmp/ddostester-durable-browser-{360,1280}.{json,png}`.

Le serveur et les fichiers temporaires de harness sont retirés du checkout après test (copies conservées hors dépôt). Un premier lancement npm avait absorbé les flags et démarré le serveur sur le mauvais port ; il a été arrêté avant le lancement correct, sans réutiliser un serveur préexistant. Cette recette valide le composant/téléchargement, pas encore l’authentification navigateur ni la route déployée sur les données du crash réel.

Le build export-05 reste vérifié actif, PID 607301, étape frontend `tsc -b && vite build` après compilation API réussie portant le checksum complet source de20b. Aucun nouveau build n’a été lancé pendant son attente.

## Reprise réseau et vérification réelle source-05

Après disparition des anciens tunnels, SSH direct confirme les quatre deployments Ready 1/1 et le build export-05 terminal avec ExecMainStatus=0/MainPID=0. Contrôle et coordinateur portent bien le digest c8f0907145329ecf718c9df5564a009c57f225fff3fc02d15bde9ce423e7b007. Un GET interne de la page retourne HTTP 200. Le tunnel API/port-forward réouvert accepte les connexions mais Chrome et curl expirent : authentification et découverte navigateur restent non validées.

Une lecture directe, sans mutation, du module compilé dans le contrôle récupère les données PostgreSQL du crash 1514819e-6007-4b8f-b78f-3bac7b8e3f66. SHA-256 recalculé identique : parent STOPPING, trois shards STOPPED, trois résultats reçus sur trois, WRS null. Export privé 0600 dans /private/tmp/ddostester-linux-real-recovered-evidence-direct-02.json. Le premier essai utilisait un chemin de module incorrect et a échoué avant lecture ; il ne constitue aucune preuve. Cette lecture valide la récupération persistée dans l’image promue, sans remplacer la recette HTTP authentifiée et navigateur encore requise. Aucune nouvelle campagne n’est lancée.

## Lecture HTTP authentifiée des preuves du crash

L’API réelle de l’image source-05 est vérifiée depuis le conteneur contrôle : login du propriétaire avec les credentials privés du laboratoire, puis GET authentifié de la route campagne. Résultat HTTP 200, Cache-Control no-store, checksum SHA-256 recalculé identique, parent STOPPING, couverture trois résultats sur trois, WRS absent. Credentials et token ne sont ni affichés ni sauvegardés dans la preuve. Export 0600 : /private/tmp/ddostester-linux-authenticated-evidence-http.json. Cette recette valide l’authentification API et les données PostgreSQL réelles, distinctement de la recette navigateur.

Un relais temporaire est démarré dans le nœud Docker identifié par creation-proof et label de laboratoire, adresse privée 172.30.94.3:18584, unité ddostester-lab-ui-forward-05 avec RuntimeMaxSec=900 et Restart=no. Le tunnel SSH local 127.0.0.1:18585 permet un GET curl HTTP 200. Chrome expire toutefois au chargement ; la découverte UI et son téléchargement réels restent à vérifier. Aucun port public n’est publié et aucune nouvelle campagne n’est exécutée.

## R08 — Taille planifiée durable et couverture sans inférence

Le coordinateur conserve désormais expected_agents (1–3) dans le parent, dans la même transaction que les assignments. Migration additive nullable : les anciens plans restent inconnus, aucune taille n’est reconstruite à partir des lignes restantes. L’export lit ce champ et le panneau affiche unknown lorsqu’il est absent. Ainsi la suppression/perte d’une ligne de shard ne réduit pas le dénominateur attendu des nouveaux plans.

Le test PostgreSQL réel planifie trois agents, retire une ligne, vérifie deux lignes présentes mais trois attendues, puis simule un ancien parent nullable et vérifie expectedAgents=null. Les 37 tests PostgreSQL du gate passent ; les deux tests UI passent, dont affichage 0/unknown. TypeScript backend/frontend passe ; la modification demeure dans les sources, non promue dans source-05. Les preuves historiques de source-05 gardent leur ancien schéma de calcul et ne sont pas réécrites.

## Gate après conservation de la taille planifiée

Le gate générique planned-coverage-verify échoue : deux assertions temporelles (sonde distante et recovery) et hook RBAC >10 s ; 1 022 tests backend passent. Une forte charge Mac est observée (load average 19,49, peu de mémoire libre). Ce résultat ne permet aucune promotion. Après vérification du handle terminal, la même suite est rejouée avec --maxWorkers=2, sans relâcher seuils ni assertions : **1 032 tests backend passent**, 26 conditionnels skipped. Puis **401 tests frontend passent** et builds backend/frontend réussissent. Lint/formatage/types avaient passé dans le premier gate, code figé pendant ces vérifications. Le gate PostgreSQL réel séparé compte 37 tests réussis. Logs privés planned-coverage-{verify,backend-02,frontend-02,build-02}. Aucun gate générique réussi unique n’est revendiqué pour le premier essai.

Le relais SSH par réponses complètes affiche l’authentification réelle Chrome et la référence source-05 ; assets JS/CSS et health/agents HTTP 200. La recette complète login/campagne reste en observation ; cette seule page visible ne prouve pas le panneau de preuves. Le relais temporaire est borné à GET et POST /api/auth/login, sans mutation de campagne ni stream, écoute loopback et expiration après quinze minutes. Son implémentation de diagnostic est conservée hors checkout dans /private/tmp/ddostester-readonly-ui-bridge.cjs.

## R01/R08 — Contrats API et champs historiques réconciliés

La section user management de docs/api.md attribuait encore user:manage au Security Officer. Vérification du RBAC et des routes : cette permission appartient à admin dans single et team. La documentation est corrigée et détaille rôle/statut, reset temporaire, révocation, transaction d’audit et protections du propriétaire. Les routes de preuves normales/durables et leurs limites sont documentées, avec statut source-only de expected_agents.

Les commentaires de reports/absorption.ts revendiquaient encore une absorption à l’edge et un tarpit déduit d’un timeout. Ils décrivent désormais les seules observations de générateur ; originRps/absorbedRatio sont marqués compatibility/deprecated, sans suppression de champ, modification des valeurs ou recalcul de score. La dépréciation est expliquée dans le contrat API, sans date de retrait inventée. Ces changements sont documentaires et postérieurs au gate runtime ; les règles de calcul restent identiques.

La recette Chrome via relais s’authentifie effectivement ; l’essai précédent attendait à tort une carte avant l’expansion d’une ligne de CampaignTable. Ce sélecteur de recette est corrigé après inspection du code. La recette panneau/téléchargement est encore en cours, sans campagne nouvelle.

La recette panneau corrigée termine en timeout avant affichage du formulaire de login sur sa nouvelle session ; elle n’a donc pas atteint le panneau. Cela ne retire pas la preuve API authentifiée ni le login navigateur acquis lors de l’essai précédent, mais le téléchargement réel reste non validé. Le relais local de diagnostic est arrêté explicitement après observation de la recette terminale, sans relancer une campagne ou une opération mutante.

## R04 — Diagnostic continu entre requêtes courtes

quality.mjs conserve les diagnostics par mesure et ajoute recentEventLoop : scope process-recent-window, fenêtre monotone réelle, nombre d’échantillons et pic. Un monitor interval-based 20 ms fonctionne entre les requêtes ; rotation chaque seconde, dix fenêtres terminées au maximum, exclusion des fenêtres terminées depuis plus de dix secondes. Une fenêtre de bord peut recouvrir le cutoff ; windowMs est explicite. Aucune mesure ne réinitialise ce monitor partagé. Avant le premier sample ou après une fenêtre invalide, le résultat est null. CPU/cgroup par mesure ne changent pas de scope.

Le backend valide et expurge l’objet optionnel, préserve les anciens samples, conserve séparément les pics par mesure et par fenêtre récente, et compte la couverture event-loop. Une couverture inférieure à 90% reste incertaine même lorsqu’un pic connu existe ; pic >100 ms dégrade la confiance. Les seuils kill et la formule WRS sont inchangés. UI/HTML/CSV ajoutent des champs explicitement nommés, sans remplacer silencieusement l’ancien pic.

Les 22 tests backend ciblés passent, dont fenêtre vide inconnue, conservation puis expiration d’un pic avec horloge/histogramme contrôlés, et blocage réel de 250 ms entre deux mesures dans un processus distinct. Deux tests UI passent ; TypeScript et ESLint ciblés passent. Le même module source est exécuté temporairement, sans installation ni campagne, dans un processus diagnostic du contrôle Linux Node **22.23.3** : six samples, pic **270,270 ms**, fenêtre **388,938 ms**, assertion de capture réussie. Preuve 0600 /private/tmp/ddostester-probe-recent-window-node22-proof.json. Cela valide la compatibilité du module, pas une nouvelle image de sonde en service.

Le gate intégré récent utilise deux workers backend afin de limiter la contention Mac, sans relâcher d’assertion : lint/types puis tests API/UI/builds séquentiels, logs /private/tmp/ddostester-recent-probe-*. Il est en cours à cette étape ; les images Linux/Mac et la production restent inchangées. Documentation officielle : https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions ; seules les API interval-based historiques sont utilisées, pas les ajouts per-iteration/snapshot récents.

Le gate récent termine avec exit 0 : lint/formatage/types, **1 035 tests backend** (26 conditionnels skipped), **402 tests frontend**, builds API/UI réussis. Il utilise deux workers API sans modifier les assertions. Le warning de bundle >500 ko reste non bloquant. Les sept preuves/logs récents sont copiés durablement dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-recovery-and-recent-probe, répertoire 0700/fichiers 0600, manifeste SHA-256 revérifié. L’export API du crash conserve sa provenance source-05 ; les tests de diagnostic récent ne sont pas une promotion d’image.

Le statut central docs/roadmap.md comporte désormais une matrice R01–R10 séparant preuves acquises et travaux restant à faire. Aucun gate complet ni raccordement infrastructure n’est déclaré sur la base de tests partiels ; G4 reste non validé.

## R02 — Sessions d’écriture et recette navigateur PostgreSQL

Décision de transport : Bearer d’écriture d’une heure pour les nouvelles sessions, cookie HttpOnly réservé aux lectures. Le JWT porte exp-iat=3600 ; login, rotation de mot de passe et self-revocation utilisent ce défaut. Le cookie expire avec la durée restante signée ; /auth/me ne renouvelle pas le JWT. Aucun refresh token ni extension glissante. Les anciennes sessions restent valides jusqu’à leur échéance signée ou révocation de version, sans reset collectif. Le stockage localStorage est conservé, avec son exposition au JavaScript de même origine explicitée ; cette réduction de durée ne prétend pas supprimer ce risque.

Deux nouveaux tests vérifient le cookie à 3600 puis 1800 s, expiration des accès Bearer/cookie, refus d’écriture par cookie seul et compatibilité d’une session historique 8 h. Le gate session-policy termine avec exit 0 : lint/types, **1 037 tests backend**, **402 frontend**, builds.

Une base PostgreSQL neuve ddostester_access_c7b993580bf7, liée au conteneur PG de recette local par son identité et son OID, reçoit uniquement un propriétaire abdelha@wedos de fixture. Le serveur est loopback 18588, scheduler/fleet désactivés ; aucun compte réel ni campagne n’est touché. Chrome vérifie via l’interface réelle : création viewer, changement forcé du mot de passe temporaire, désactivation et refus du JWT précédent, filtre Disabled, réactivation, profil engineer, révocation explicite et refus immédiat, reset temporaire et suppression. Le seul admin reste le propriétaire. La vérification PostgreSQL finale conserve une chaîne valide de **20 entrées**, incluant les actions utilisateur/status/reset/révocation/suppression.

La première capture 360 px révèle un défaut réel : .shell.dock-open/min rétablissait deux colonnes après le breakpoint mobile, comprimant le contenu. Une règle mobile prioritaire rétablit une seule colonne ; le footer de navigation passe en wrap pour éliminer le débordement restant. Chrome mesure scrollWidth=viewport à **360/720/1280**, main=360/720/652 px ; le bureau conserve 244/652/384 px. Capture de la carte mobile inspectée : tous les champs/boutons et propriétaire lisibles. Builds frontend et lint passent après CSS ; ces vérifications complètent le gate fonctionnel préalable, sans prétendre qu’il avait testé ce dernier CSS.

Preuves privées /private/tmp/ddostester-access-browser-session-policy : browser-proof.json, audit-proof.json, mobile-layout-proof.json, captures avant/après. Le serveur est arrêté avec exit 0 ; zéro connexion de fixture puis vérification OID/identité, suppression de cette seule base confirmée, credentials de fixture supprimés. cleanup-proof.json conserve le résultat. Les recettes CISO, expiration/reconnexion SSE et l’ensemble du clavier/contraste restent à compléter. Politique de session et CSS sont source-only, production 451 et Linux source-05 inchangés.

Le gate PostgreSQL obligatoire complète cette étape avec **37 tests réussis**. Les 20 artefacts/logs de recette sont conservés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-user-browser-and-session-policy (0700/0600), manifeste SHA-256 revérifié ; aucun config de credentials n’est archivé. Les captures initiales restent conservées comme preuve de défaut, distinctes des captures corrigées.

## R04 — Réponses de sonde fraîches et liées à la requête

Le transport de baseline, phases et recovery émet désormais ddostester.probe.request/v2 avec requestId aléatoire 128 bits. La sonde versionnée restitue ddostester.probe.response/v2, le même identifiant et observedAt après mesure. Le contrôle vérifie cette identité, l’horloge d’observation dans la fenêtre de requête (+/-2 s), les diagnostics sampledAt et un éventuel recul de son horloge locale. Réponse rejouée, ancienne, sans enveloppe ou horloge trop future refusée ; pas de repli local. Le validateur de samples historiques reste séparé : aucun ancien rapport n’est rétroactivement validé ou rescored.

La sonde accepte encore les requêtes legacy non versionnées pour permettre la promotion probe-first, mais leurs réponses ne sont pas admises par le nouveau contrôle. /health annonce le protocole v2. Les identités Bearer restent nécessaires ; le challenge assure une corrélation fraîche avec un agent de confiance, pas une signature ni une preuve autonome d’arrivée cible. Les requêtes versionnées malformées échouent avant I/O cible.

Les tests ajoutent identifiant divergent, réponse ancienne, clock-skew excessif, diagnostic périmé, recul local et replay du premier résultat au second appel de transport. Les fixtures baseline/recovery/live répondent maintenant avec la vraie enveloppe. Le gate complet est en cours dans /private/tmp/ddostester-probe-freshness-{lint,types-02,backend,frontend,build}.

Une recette autonome Node **22.23.3** dans le laboratoire Linux charge temporairement les seuls scripts de sonde dans un répertoire exclusif privé. Deux GET atteignent uniquement une fixture loopback : demande v2 et demande legacy. Demande v2 malformée HTTP 400 sans nouvelle arrivée cible, nonce/date v2 conformes, annonce health et compatibilité probe-first vérifiées. Processus enfant, serveur cible et fichiers temporaires sont nettoyés en finally ; commande exit 0. Preuve 0600 /private/tmp/ddostester-probe-freshness-node22-proof.json. Cela n’installe aucune image ni service, n’exécute aucune campagne et ne modifie pas les reçus historiques du laboratoire.

Le gate freshness termine avec exit 0 : lint/types, **1 040 tests backend** (26 conditionnels skipped), **402 frontend**, builds API/UI réussis. Six preuves/logs sont copiés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-probe-response-freshness (0700/0600), manifeste SHA-256 revérifié. Aucune image de sonde/contrôle n’est promue dans cette étape. Pour une promotion future : sonde v2 d’abord, requête v2 réelle vérifiée, contrôle ensuite ; retour arrière contrôle d’abord. Les anciens contrôles restent compatibles avec la nouvelle sonde.

## R04 — Baseline manquante distincte d’une cible indisponible

La capture remote conserve maintenant observation : vantage, taille attendue, réponses reçues/manquantes et complétude. Une réponse de sonde validée compte comme observation même si elle signale un échec d’accès cible ; une panne de transport, enveloppe périmée ou interruption reste manquante. Les nombres historiques samples/availabilityPct sont conservés pour compatibilité, mais ne prouvent pas l’état cible lorsque la couverture est incomplète.

computeBaselineDelta ne retourne aucun delta pour une baseline vide/incomplète. L’interface affiche unknown et la couverture ; HTML signale l’absence et refuse même un delta contradictoire fourni dans la fixture. La comparaison entre baselines pour notifications de drift est également absente lorsque l’une manque. Le contrôle dégrade la confiance ; assessment impose inconclusive pour une baseline remote incomplète, y compris après KILLED_AUTO. Le statut d’arrêt et ses seuils ne sont pas modifiés, ni la formule WRS. Les anciennes métadonnées/évaluations stockées ne sont pas réécrites.

La première vérification TypeScript a trouvé un consommateur notification qui supposait toujours un delta. Le contrat de drift devient explicitement optionnel et le constructeur de notification le gère ; aucun zéro n’est inventé. TypeScript API/UI passe après correction. Les 63 tests backend ciblés et 15 UI passent. Deux tests additionnels couvrent HTML contradictoire et absence de verdict drift, puis un gate intégré est lancé dans /private/tmp/ddostester-baseline-observation-*. Il reste en cours ; aucune image/application en service n’est mise à jour. La restitution des diagnostics de ressources baseline/recovery reste un travail distinct non encore terminé.

Le gate baseline-observation termine avec exit 0 : lint/types, **1 044 tests backend**, **403 frontend**, builds réussis. Le texte de notification critique d’arrêt est ensuite précisé pour une baseline remote incomplète : arrêt de sécurité signalé, disponibilité cible à vérifier, sans attribution automatique à la cible. La sévérité et l’arrêt restent inchangés. Les **22 tests notification** passent après cet ajout ; il ne fait pas partie du décompte de la suite complète préalable. Aucun sink n’est appelé ni message externe envoyé dans cette recette. TypeScript/build backend et ESLint ciblé sont lancés pour cette dernière modification de texte.

Les contrôles finaux de notification passent : TypeScript/build backend et ESLint ciblé. Sept logs sont archivés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-baseline-observation (0700/0600), manifeste SHA-256 revérifié. Les images en service et les comptes réels restent inchangés.

## R04 — Diagnostics baseline préservés jusqu’au rapport

Le calcul de couverture/pics est extrait en summarizeProbeQuality et réutilisé sans changement de formule pour baseline et sonde sous charge. Les réponses remote validées conservent leurs diagnostics dans baseline.quality : dernier sample CPU/RSS/cgroup, couverture, pic par mesure, pic de fenêtre récente et fraction throttled. L’absence reste inconnue ; les fenêtres partagées ne sont pas des coûts indépendants. Chaque phase reste distincte.

Les diagnostics manquants ou contendus de baseline dégradent la confiance, empêchent un delta fiable et la notification de drift qui en dépend. Assessment et texte de notification de sécurité refusent d’attribuer à la cible une baseline incertaine. Ni arrêt, ni formule WRS ne changent. UI réutilise le panneau avec titre Remote baseline diagnostics ; HTML et CSV exportent couverture/pics de baseline séparément. Les historiques sans quality restent lisibles.

TypeScript API/UI et **77 tests backend ciblés**, **18 UI** passent. Le corpus comprend une réponse diagnostiquée sur deux observations : couverture 1/2, pic récent 175 ms, throttling 0,2 et dernier RSS conservés, sans remplir le sample manquant. Tests HTML/CSV vérifient la séparation baseline/load et zéro throttled réel. Le gate complet baseline-quality-* est en cours, sources figées. La qualité de recovery reste à préserver séparément.

Vérification Linux en lecture seule : contrôle/fleet/probe/cible Ready 1/1. Le relais temporaire ddostester-lab-ui-forward-05 est terminal (MainPID=0, Result=timeout), conformément à son RuntimeMaxSec de quinze minutes ; il ne s’agit pas d’une panne de deployment. Après observation de leurs handles encore vivants, ses tunnels locaux 18585/18583 sont arrêtés et observés terminaux. Les autres accès, services de monitoring et images restent inchangés.

Le gate baseline-quality termine avec exit 0 : lint/types, **1 048 backend passent** (26 conditionnels skipped), **404 frontend**, builds API/UI réussis. Cinq logs sont conservés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-baseline-quality (0700/0600), manifeste SHA-256 revérifié. Cette validation couvre les sources et diagnostics de baseline ; elle ne valide ni une promotion d’image, ni la conservation des diagnostics recovery encore ouverte.

## R04 — Qualité et provenance du gate recovery

RecoveryResult conserve maintenant la couverture des réponses remote, la même synthèse diagnostique que baseline/load et verified. available reste une observation brute de joignabilité ; verified requiert réponses complètes et diagnostics suffisants sans contention. La suite refuse l’avancement si verified=false, y compris après un HTTP 200 cible, et n’attribue pas cet état à une cible indisponible. Les snapshots de gates sont conservés dans l’audit de décision ; repeated skips auto-pausent comme auparavant.

Un gate passé est attaché au rapport du prochain step comme recoveryBeforeRun, distinct d’une récupération après ce run. UI/HTML/CSV et export fleet l’exposent explicitement. Le stockage n’écrase pas une campagne avec un snapshot ancien : le résultat est passé en argument interne à runCampaign puis ajouté au run avant saveRun. Gate échoué/inconnu reste dans l’audit, sans rapport de charge inventé.

Le chronométrage et la borne d’attente utilisent performance.now ; timeout de requête et sleep sont limités au budget restant. Des ajustements d’horloge murale ne prolongent pas le gate. Le contrôle de freshness v2 reste appliqué à chaque réponse, indépendamment du chronométrage monotone.

TypeScript passe ; **42 tests backend ciblés**, **18 UI** passent avant ajout des assertions de restitution. Le corpus vérifie disponible mais non vérifié sans diagnostics, ressource saine vérifiée, et sleep ramené au budget restant. Une assertion d’intégration suite vérifie maintenant recoveryBeforeRun sur le rapport du second step ; HTML/CSV et UI identifient avant-step. Le gate complet recovery-quality-* est lancé sur sources figées. Aucune image ni service en exploitation n’est mis à jour dans cette étape.

Le gate recovery-quality termine avec exit 0 : lint/types, **1 052 backend**, **405 frontend**, builds API/UI réussis. L’intégration suite retrouve recoveryBeforeRun dans le rapport du second step. Le contrat de store est ensuite enrichi pour préserver exactement les diagnostics de baseline et la couverture/qualité du gate sur les deux stores ; les **37 tests PostgreSQL obligatoires** passent sur la base de test réelle, avec TypeScript et ESLint ciblé après cette assertion supplémentaire. Aucun état de campagne réelle n’est utilisé par cette fixture. Sept logs sont archivés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-recovery-quality (0700/0600), manifeste SHA-256 revérifié. Cette étape valide les sources, pas une promotion d’image ni une recette de reprise Linux sur ces sources.

## R04 — Barrière de suite vérifiée malgré HTTP 200

Un nouveau test d’intégration démarre une cible et une sonde de fixture exclusivement loopback, avec protocole v2 frais et réponses HTTP 200 dépourvues de diagnostics. La première étape bornée est approuvée/exécutée via les routes de gouvernance ; la récupération de la suivante produit available=true/verified=false. La suite conserve un suite.skip unverified, laisse la deuxième campagne APPROVED et ne crée aucun run pour elle. Le test passe en 7,67 s, avec ESLint et TypeScript ciblés. Cette sonde est une fixture volontairement incomplète, pas une preuve de performance ou de diagnostics d’une sonde réelle. Aucun VPS ni campagne externe n’est utilisé.

Cette assertion supplémentaire complète le gate recovery-quality préalable (1 052 backend/405 frontend) sans modifier le comportement applicatif. Le snapshot source suivant est préparé hors checkout, avant toute construction/promotion, pour regrouper les changements validés depuis source-05. La branche et l’index restent préservés.

## Source-06 figé, transféré et construction native

Le snapshot source-06 contient **578 fichiers**, archive **1 806 794 octets**, SHA-256 **7e1c8ee4ab35a288322d9e717758611d9613db8a7a72f7e582bb56457a39346e**, manifeste **777ce01258f1d5766d3af7e0a68ccd86608f317edf9be10d0a1180b68c1c3328**. Référence Git inchangée d98db08ecb520b4021df645e7aded44fe38ad939. Archive/manifeste/fichiers sont vérifiés localement puis après SCP sur VPS, dans un répertoire source-06 exclusif privé, après contrôle de l’identité du nœud de laboratoire. Archives et images antérieures restent conservées.

Extraction uniquement de fichiers réguliers et chemins relatifs sans traversée, puis copie dans un contexte builder nouveau /tmp/ddostester-source-06. Aucun export natif antérieur n’est actif. Le builder est running sans OOM, limites 1,5 Gio/0,5 CPU vérifiées. L’unité ddostester-native-export-06 est lancée une seule fois ; **PID 634854** observé active/running, étape npm build backend. ExecMainStatus=0 à ce stade n’est pas une preuve de fin, puisque le PID reste actif. Log /var/lib/ddostester-linux-lab-attempt-03/control-source-06/native-export-6.log.

La future image est associée à snapshot:7e1c8e… ; elle n’est pas encore importée/promue ni vérifiée en service. La sonde v2 doit être promue et vérifiée avant le nouveau contrôle. L’application Linux conserve source-05 et la production build 451. Le snapshot contient le journal avant ce bilan post-capture ; ce bilan ne prétend pas faire partie de l’archive déjà figée.

## Promotion Linux source-06, sonde d’abord

Le contrôle export-06 termine avec MainPID=0/ExecMainStatus=0 ; compilation API/UI et contrôle portable-runtime réussissent. Archive 69 262 848 octets SHA-256 4f2edb9eae15b57524e16e09330df834d10033156a818fefb4f72c214c724637 ; image **docker.io/library/ddostester-lab-control@sha256:5a50d8220442d1e0134f61559484e03b35288e0d8e8e5f8e3cba6ab25b6321be**. Les anciennes archives/images restent présentes.

La sonde est construite depuis le même source-06 dans le builder borné : export terminal succès, archive 60 723 200 octets SHA-256 c388e01e8c028db6c06c49e1a31382fbef757ffbca79e0c61fab1268bedc8891, image **docker.io/library/ddostester-lab-probe@sha256:7b7173d524a23d5682fc7364657c98404dc1449b0b0a0ebe8ce55a7d301e9711**. Import vérifie taille/checksum/platform/noms/digests et absence de Jobs, puis patch image seul avec test de l’ancienne valeur. Rollout réussi ; Pod UID 843000de-803e-421f-a3dd-e91bd9df45af, IP 10.247.0.50, imageID identique. Limites préexistantes 250m/256Mi, requests 100m/64Mi, inchangées.

Deux GET légitimes vers la cible dédiée vérifient nonce/date v2 et compatibilité legacy depuis l’ancien contrôle. Le premier pic récent est **266,600 ms** : fonctionnement protocole vérifié, mais contention récente signalée, sans déclarer la mesure saine. Coordinateur ensuite promu. La première tentative de patch contrôle s’arrête avant application sur une garde : loopback-access portait une variable FLEET_AGENT_IMAGE ancienne d2adf7…, alors que son image et l’agentImage du contrôle étaient c8f090…. Cette variable n’était pas utilisée par le proxy ; les valeurs observées sont testées individuellement avant correction. Rollout contrôle/loopback réussi ; toutes les références agent/contrôle sont désormais 5a50d8….

Le vérificateur API/UI confirme **snapshot:7e1c8ee4ab35a288322d9e717758611d9613db8a7a72f7e582bb56457a39346e build lab**, avec les checksums d’assets. Recette authentifiée réelle : propriétaire admin HTTP 200, JWT exp-iat=3600 et cookie Max-Age=3600, export du crash HTTP 200/checksum valide, trois résultats reçus et expectedAgents=null pour ce plan historique sans taille persistée. Le nouveau transport sampleRemoteProbe valide une réponse v2 réelle HTTP 200 ; pic récent **65,536 ms** à cette mesure. Un premier wrapper de collecte avait une regex mal échappée et échouait avant sauvegarde de preuve ; le second termine exit 0. Aucun token/password n’est conservé dans les preuves.

Neuf artefacts/logs sont conservés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-linux-source06-promotion (0700/0600), manifeste SHA-256 revérifié. Aucun nouveau run de flotte n’est lancé dans cette étape. Recettes flotte/arrêt et découverte/téléchargement navigateur sur cette image restent à refaire ; promotion n’équivaut pas à passage global de G2/G3/G4. Production reste build 451 ; Mac conserve ses images précédentes.

## Phases et flotte réelle sur source-06

Au repos, le contrôle compilé capture trois observations baseline sur trois et deux checks recovery via la sonde v2 réelle. Diagnostics baseline 3/3 et recovery 2/2, pic récent 31,277 ms, throttling mesuré 0, recovery available=true/verified=true. La comparaison est autorisée avec des latences identiques à la baseline : cette assertion ne mesure aucune dégradation sous charge. Ces cinq GET restent limités à la cible dédiée.

Une campagne gouvernée distincte utilise ensuite lab-smoke.py --duration 30 --require-complete : trois agents, 3 RPS globaux, concurrence 3, max 30 s. L’opérateur entre uniquement dans le namespace réseau du nœud Docker identifié, avec port-forward loopback et copie de credentials exclusive privée. Aucun endpoint public ni production ciblé.

Run **77bda5d8-873d-4519-adda-d683a8edd779** : COMPLETED, trois SUCCEEDED, measurementComplete=true, **54 requêtes rapportées / 54 reçus cible**, IP privées **10.247.0.53/.54/.55**, checksum d’export vérifié. CounterCoverage explicite 3/3 depuis le plan persistant. Observation baseline 3/3 et diagnostics 3/3 ; diagnostics sous charge 29/29, throttling sous charge 0.

Le rapport reste **inconclusive** : throttling de sonde pendant baseline **0,66949**, confiance degraded=true et cause explicite ; débit émis **1,9088 RPS** pour 3 demandés. Pic récent baseline/load **66,617 ms**. Données complètes ne signifient donc ni mesure saine ni mitigation corroborée. Aucune limite CPU/RPS relevée pour faire réussir la recette.

Après retour terminal du helper, le port-forward est arrêté et sa copie de credentials supprimée. Quatre artefacts sont archivés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-linux-source06-fleet (0700/0600), manifeste SHA-256 revérifié, originaux VPS conservés. Phases au repos et charge gardent leurs scopes distincts. Le premier append du journal échoue sur encodage avant écriture ; ce patch conserve le bilan vérifié. Les corpus panne/arrêt et suite recovery restent à compléter.

## R01/R05 — Référence de manifests et compatibilité opérateur

Les manifests génériques utilisaient encore les tags local et ne déclaraient pas FLEET_ENABLED/agentImage. Une couche releases/linux-source-06 épingle les cinq images : contrôle/probe de source-06, auxiliaires de l'import initial avec digests vérifiés sur Pods et cache containerd. Kustomize replacements copie l'image du contrôle vers FLEET_AGENT_IMAGE. Aucun digest d'auxiliaire n'est présenté comme une reconstruction source-06.

Le rendu local compte trente ressources et sept références immuables ; agentImage correspond au contrôle, scheduler off et pas de Secret inline. verify-lab-render.mjs refuse tags/images divergents, exposition Service publique, ressources non prévues, namespaces hôte et init containers non revus. Quatre fixtures négatives sont effectivement refusées : agent ancien, cible flottante, LoadBalancer et Ingress ajouté. Rendu et vérificateur passent, avec ESLint/diff-check. Cette couche n'est pas appliquée : bootstrap, identités, egress API découverte et revue CoreDNS restent séparés ; les auxiliaires en service utilisent encore leurs tags locaux.

L'inventaire opérateur révèle kubectl Mac **1.32.2**, Kustomize **5.5.0**, face au serveur/client Linux **1.37.1+k3s1**, Kustomize **5.8.1**. La documentation officielle limite kubectl à une version mineure d'écart ; l'accès live avec le client Mac est donc hors plage supportée. Cela ne démontre pas la cause des tunnels défaillants précédents. Le client Linux embarqué utilisé pour les promotions est compatible. Un téléchargement officiel kubectl 1.37.1 darwin/arm64 est en cours dans un répertoire privé dédié, sans remplacer le client global ; le fichier partiel est 0600 et ne devient exécutable qu'après vérification SHA-256. Il n'est pas encore déclaré installé.

Cinq rendus positifs/négatifs sont archivés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-release-render (0700/0600), avec manifeste SHA-256 revérifié : un rendu valide, quatre variantes refusées. Aucun apply ni nouveau déploiement dans cette étape. Le téléchargement privé reste observé actif, fichier partiel non exécutable ; une progression de taille ne remplace pas la vérification finale du binaire.

## Rendu confirmé avec le client Kubernetes compatible

Les seuls fichiers YAML/JSON de configuration sont transférés dans un répertoire privé exclusif, puis copiés vers le nœud de laboratoire après vérification de son identité. Le kubectl embarqué 1.37.1+k3s1 / Kustomize 5.8.1 effectue uniquement kustomize, sans apply ni requête de mutation au cluster. Son rendu de trente ressources passe le vérificateur de référence et correspond exactement au rendu Mac 1.32.2 / Kustomize 5.5.0 : SHA-256 commun **d08d3a1c2854a18e125b832b965759313b693ec642ea46c307fd94811787ace3**, 18 736 octets. L'égalité est aussi vérifiée sur les objets YAML parsés.

Cette preuve valide le rendu entre ces deux versions ; elle ne rend pas supporté l'accès API du client Mac ancien et ne complète pas l'installation. Le téléchargement privé 1.37.1 reste vérifié actif, progression jusqu'à 25 Mio, fichier non exécutable. Aucun remplacement du kubectl global, kubeconfig ou contexte d'un autre projet.

## R08 — Coût de démarrage expliqué sans compensation du débit

L'examen du run 77bda5d8 montre un parent de 28,290 s et des générateurs actifs environ 18,1–18,3 s. Leurs débuts sont décalés de **9 720 / 9 832 / 9 852 ms** après le parent ; chacun rapporte **0,99 RPS** sur sa propre fenêtre active. Le débit global reste **1,9088 RPS**, avec le démarrage inclus au dénominateur. Ces fenêtres ne sont pas remplacées par une somme de taux actifs pour prétendre atteindre 3 RPS.

fleetStartupEvidence ajoute un diagnostic versionné, couverture et délai par agent, premier/dernier délai connu. Seuls les intervalles générateur cohérents à l'intérieur du parent sont retenus ; champs manquants, horloge incompatible ou incohérente restent null. Le scope décrit les horodatages de générateur et non les premières arrivées cible. UI/HTML/CSV/export ajoutent ces champs sans changer les caps, délais, compteurs ou scores. Un recul de l'horloge parent provoque désormais une erreur au lieu d'un dénominateur artificiel de 1 ms et d'un débit énorme.

Le helper est exécuté sur l'artefact réel conservé, dans une preuve distincte marquée derivedAfterRun=true ; il retrouve couverture 3/3 et les délais 9 720–9 852 ms. Le run source-06 et son score ne sont pas modifiés. TypeScript passe ; tests nouveaux couvrent timestamp absent, agent avant parent et parent à horloge future. Gate complet fleet-startup-* en cours sur sources figées, sans nouvelle campagne. Le client privé continue son téléchargement observé, au-delà de 46 Mio, toujours non exécutable avant checksum.

Le premier gate startup termine en échec sur une course temporelle du test recovery existant : un timer arrondissant une durée fractionnaire vers le bas permettait un deuxième check à la toute fin du budget. 1 054 tests passent et un échoue ; ce gate n'autorise aucune promotion. Le recovery ferme maintenant le polling lorsque le sleep a été tronqué jusqu'au budget restant, même si le timer réveille trop tôt. L'assertion un seul check est conservée. Treize tests recovery/summary passent après correction ; un second gate complet est lancé sur les sources figées, logs fleet-startup-*-02. Les images source-06 ne sont pas modifiées.

## Résultats startup, client compatible et interface mobile

Le second gate termine avec succès : lint, types, build, **1 055 tests backend passés / 26 conditionnels ignorés**, et **405 tests frontend passés**. Les tests ignorés ne constituent pas une validation de leurs dépendances externes. Ces résultats précèdent le correctif CSS décrit ci-dessous.

Le téléchargement officiel du client privé kubectl 1.37.1 darwin/arm64 est terminé et son SHA-256 vérifié : fd65982c97ddad3106754b69ffa196d0e543aa591930ae52aed1adfb92f8c77f. Le binaire privé devient exécutable après vérification ; accès aux quatre Deployments Ready et port-forward du contrôle réussis avec ce client. Le kubectl global et les contextes des autres projets restent inchangés.

Chrome authentifié sur source-06 ouvre les preuves enregistrées de la campagne interrompue 1514819e-6007-4b8f-b78f-3bac7b8e3f66 : réponse API 200, trois rapports avec dénominateur historique inconnu, téléchargement identique à la réponse et checksum valide. Le premier contrôle mobile échoue : le SHA complet du pied de navigation impose un scroll horizontal de 510 px sur un viewport de 360 px. Le correctif local autorise son retour à la ligne. Une injection de ce seul style candidat sur la page réelle donne scrollWidth=360 et largeur du texte=328 ; capture inspectée et panneau lisible. Il s'agit d'une validation du style candidat, pas d'une promotion du CSS. Prettier et le build frontend passent ensuite sur le fichier modifié.

Les logs du gate, diagnostic startup dérivé, téléchargement, preuve mobile, capture et log de build sont conservés avec manifeste SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-startup-and-mobile, permissions 0700/0600. Production reste build 451 ; source-06 ne contient pas encore les derniers changements startup, recovery et CSS. G2/G3/G4 ne sont pas déclarés complets.

## R09 — Première recette opérationnelle des adaptateurs

scripts/conformance/engines.ts exécute les vrais adaptateurs sur un serveur loopback qu'il crée lui-même, sans accepter d'URL configurable ni télécharger de binaire. Budgets 2 RPS / concurrence 2 / durée 3 s, scénarios GET lent, redirection et arrêt ; reçus monotones et pic de concurrence côté cible. Le fichier de preuve est réservé exclusivement avant toute requête. Une tentative sur un fichier existant échoue EEXIST avant création de cible, préservant la preuve antérieure. ESLint et Prettier passent.

Sur ce Mac sous **Node v26.8.1**, builtin passe les trois scénarios : six reçus / pic de concurrence 2 pour le GET lent ; six / pic 1 et aucun suivi de redirection ; quatre / pic 2 pour l'arrêt déclenché à 1 200 ms, terminaison environ 1 210 ms, aucun reçu au-delà du seuil d'une seconde après arrêt. Ces checks sont opérationnels et bornés ; ils ne couvrent pas la conformité complète, les flows ou phases ni la parité Linux Node 22.

k6, Vegeta, Locust, JMeter et Gatling sont absents du PATH observé et enregistrés unavailable/not-validated. Un inventaire terminé avec code 0 n'est pas un passage de conformité. Les six artefacts sont archivés avec manifeste SHA-256 vérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-engine-loopback (0700/0600). La procédure et ses limites sont décrites dans scripts/conformance/README.md. Les versions exactes externes et le corpus six moteurs restent à obtenir sur un environnement équipé ; aucune campagne produit, cible publique ou production n'a été utilisée.

## R09 — Erreurs cible et exécution Node 22

La recette ajoute HTTP 503 et timeout : elle exige des échecs sans succès, des compteurs total=successful+failed et, hors annulation, totalRequests égal aux reçus. Le temps de terminaison est désormais mesuré directement avant la période d'observation après arrêt, sans soustraire une durée de timer supposée exacte. Les timers de réponse cible sont libérés quand la connexion ferme. ESLint, Prettier et compilation TypeScript isolée passent.

Sous Node 26.8.1 local, les cinq scénarios passent : six reçus pour bounded/redirect/error/timeout et quatre pour stop. HTTP 503 et timeout rapportent chacun six échecs et zéro succès. Arrêt environ 1 210 ms.

Le runtime natif VPS répond Node 22.23.2, mais aucun arbre compilé du builder n'est encore présent sur le chemin examiné. L'image de contrôle source-06 existe dans Kubernetes. Une première commande se trompe de ressource : loopback-access est un conteneur du Deployment lab-control, pas un Deployment ; les deux accès concernés sont refusés NotFound et n'exécutent pas la recette. Après inventaire du Deployment et vérification de son image 5a50d822…, le script transpillé est exécuté dans ce conteneur d'accès, avec cible créée uniquement sur loopback, sans modifier les manifests, credentials ou processus principal. Le fichier exclusif temporaire utilise /dev/shm, le système de fichiers racine restant en lecture seule.

Le processus est observé actif avant terminaison, sans relance ; une lecture intermédiaire du fichier réservé est vide et n'est pas utilisée comme preuve. Le processus termine ensuite exit 0. Son runtime réel est **Node 22.23.3**, distinct du binaire hôte. Les cinq scénarios passent : bounded cinq reçus / 3 398 ms, redirect cinq / 5 204 ms, error six / 3 104 ms, timeout six / 3 025 ms, stop quatre / 1 206 ms. Les limites existantes du conteneur sont 100 mCPU / 128 MiB. Les délais et le sous-débit sont conservés, sans attribuer leur cause exclusivement au throttling et sans prétendre garantir le débit demandé. Cette recette ne valide ni les moteurs externes ni les phases/flows ou la conformité complète.

Les deux preuves JSON et le script transpillé exact sont archivés avec manifeste SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-engine-loopback-errors (0700/0600). Production reste build 451 ; aucun déploiement ni campagne produit n'est modifié.

## R09 — Correction de programmation k6 des flows à bas débit

L'examen préparatoire des profils IoT révèle que iterationRate arrondissait au minimum une itération par seconde, même si le budget était inférieur au nombre d'étapes. Un flow de trois requêtes à 1 RPS programmait ainsi trois requêtes par seconde. Le test d'invariant historique tolérait cette hausse avec Math.max(rps, steps), malgré sa description de cap global.

Le helper autorise désormais zéro itération dans une fenêtre d'une seconde. L'adaptateur k6 élargit son timeUnit commun selon le plus petit budget des phases pour conserver des arrivées entières sans relever le budget : trois étapes / 1 RPS deviennent une itération par trois secondes ; une requête / 0,5 RPS devient une itération par deux secondes. Les autres phases utilisent la même unité et leurs propres nombres d'arrivées. Les taux non finis, périodes ou nombres d'arrivées non représentables sont refusés. Ce comportement utilise les options rate entier / timeUnit documentées dans la [documentation officielle k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/).

Les tests couvrent petits budgets, phases, taux fractionnaire, limites numériques et l'invariant du débit programmé (arrivées × étapes / période ≤ budget). L'ancien invariant est corrigé sans tolérance relevant la limite. Cette preuve porte sur la programmation du script ; elle ne prouve pas un plafond instantané des requêtes de chaque étape, les rafales ou la conformité du vrai binaire absent. Les recettes réelles de flows/phases restent requises. Les profils IoT reproductibles ne sont pas encore implémentés. Le correctif reste local, hors image source-06 et production.

Validation finale : **49 tests ciblés passés**, typage backend, ESLint et Prettier passent. Une première vérification ESLint refuse les espaces littéraux du regex de test ; le regex utilise ensuite une classe d'espacement et la vérification est relancée avec succès. Les deux logs finaux sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-k6-low-budget (0700/0600). Ces tests ciblés ne sont pas un nouveau gate complet ni une autorisation de promotion.

## R09 — Profil de capteur HTTP reproductible

Le contrat de campagne accepte maintenant iotProfile={id:sensor-heartbeat/v1,seed:uint32,deviceIndex:0..999}. Le compilateur détermine par SHA-256 une identité synthétique, un payload JSON inférieur à 256 octets et deux pauses bornées, sans horloge ni état aléatoire. Flow : GET vers probeUrl, think-time 500–1 500 ms, POST JSON vers target, pause 1 000–2 000 ms. Les URLs doivent partager une origine et passent les vérifications habituelles d'allowlist. Sequence reste 0, explicitement échantillon statique, sans prétendre simuler une série temporelle ou un firmware.

Le service compile le flow avant approbation, conserve profil/graine/index, sans changer les budgets ou muter l'entrée. Il exige explicitement agent=builtin/vector=http-post et refuse les configurations conflictuelles. L'examen des appels createCampaign révèle qu'ils servent aussi de préflight sur les campagnes persistées : la revalidation accepte donc leur flow uniquement s'il correspond exactement au développement du profil. Une modification de graine seule ou un flow divergent sont refusés. Les contrôles de lancement et de confirmation restent existants ; fleet MVP ne prend pas encore en charge ces flows.

Les routes création/lecture réelles sont testées : HTTP 201 puis 200, flow et profil conservés, PENDING_APPROVAL, aucun run créé. Une cible loopback dédiée reçoit effectivement le GET et le POST avec payload/content-type attendus et think-time mesuré ; compteurs égaux aux reçus, zéro échec et budget total respecté dans cette recette. **54 tests backend ciblés passent**, incluant refus des index/graines invalides, moteur absent/fleet, flow conflictuel et cible non autorisée. Typage backend/frontend passe à cette étape. Le panneau de détails et le rapport HTML identifient ensuite le profil et ses limites ; le rapport a un test dédié.

La procédure est documentée dans [iot-profiles.md](./iot-profiles.md), avec brouillon non autorisé par défaut. Le choix de profil dans le formulaire, les comparaisons/export enrichis, les runs cluster et les moteurs externes restent à compléter. Sources locales seulement ; source-06 et production build 451 ne contiennent pas encore ce profil. Gate ciblé types/build/frontend lancé après ajout du détail UI, sans nouvelle campagne cluster.

Ce gate ciblé termine exit 0 : typage backend/frontend, build complet et **26 tests frontend passés**. Le build émet son avertissement existant sur la taille des chunks ; ce n'est pas une validation du budget bundle ni du corpus navigateur complet. Les quatre logs types/build/backend/frontend sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-iot-profile (0700/0600). Les validations restent ciblées, sans promotion.

## R09 — Choix du profil IoT dans le formulaire

Le formulaire expose Synthetic device journey, graine et index associés à leurs labels. Choisir sensor-heartbeat/v1 sélectionne explicitement builtin/http-post, sans changer les budgets ni effacer les champs saisis. Des paramètres invalides, une origine différente, un moteur/vector incompatible ou des champs conflictuels bloquent la soumission avec une indication de correction. L'attestation demeure requise ; aucun flow généré côté client ne remplace le compilateur serveur.

Le helper de formulaire refuse valeurs vides, négatives, fractionnaires et hors bornes. Les tests de composant prouvent le payload graine/index, moteur explicite et budgets inchangés après attestation ; un body existant est conservé et interdit la soumission IoT. Typage frontend, ESLint, Prettier et build passent ; 34 tests ciblés de formulaire/pages, puis 23 tests helper/composant passent (corpus partiellement commun, ne pas sommer comme tests distincts). L'avertissement de taille bundle reste présent. Ce contrôle jsdom ne prouve pas la recette Chrome complète ou mobile du nouveau formulaire.

Les quatre logs sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-iot-form (0700/0600). Documentation du profil actualisée. Exports/comparaisons, support fleet des flows et recette cluster restent à compléter. Modifications locales seulement, sans promotion ni lancement de campagne.

## R08/R09 — Profil capturé dans le résultat du run

Le runner copie les paramètres publics du profil dans la configuration du générateur au démarrage. Le CSV de synthèse ajoute iotProfile/iotSeed/iotDeviceIndex à partir du résultat enregistré ; le rapport HTML utilise aussi ce snapshot, plutôt que la campagne courante. Ainsi une modification ultérieure de la graine de campagne ne doit pas changer la provenance affichée du run. Un test de runner exécute le profil sur sa cible dédiée et vérifie cette indépendance. Tests de rapport confrontent volontairement une graine de campagne différente au snapshot ; l'historique sans snapshot ne doit pas se voir attribuer un profil rétroactivement.

Première vérification ciblée en cours ; le cas historique sans config de générateur révèle un accès trop strict à corriger avant d'accepter ces exports. Aucun résultat de ce gate n'autorise une promotion. Source-06 et production restent inchangés.

Cette première tentative termine en échec : 26 tests passent, mais la suite report ne collecte aucun test car son rendu de fixture historique accède à config.iotProfile alors que config est absente. Le rapport et le CSV utilisent ensuite l'accès optionnel, sans fallback vers les paramètres courants. Le test nouveau fournit un véritable snapshot au résultat, puis vérifie les colonnes vides de l'historique. Le runner copie aussi le flow pour empêcher une modification ultérieure de ses étapes de changer le résultat enregistré.

La seconde vérification termine exit 0 : typage backend et **41 tests ciblés passés** (rapport, runner, profil). ESLint des fichiers concernés passe. Le test du runner vérifie l'indépendance après modification de la graine et du body de campagne ; la campagne de fixture est explicitement placée APPROVED. Les quatre logs des deux tentatives sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-iot-run-exports (0700/0600). Les comparaisons homogènes, la recette cluster et le gate complet de release restent requis ; aucune promotion n'est effectuée.

## R08 — Contrôle de comparabilité avant interprétation des écarts

L'ancien compareRuns classait principalement l'écart WRS sans confronter charges ou incertitude. Le contrôle versionné runComparability compare maintenant les configurations enregistrées et exige un contexte identifié, score mesuré valide, confiance non dégradée, assessment conclusive et observations cohérentes. Le runner capture moteur, Node, référence source, URL/vantage de sonde. Configurations, graine/index, flows et headers fonctionnels différents rendent le résultat inconclusif ; seul le tag de traçabilité et le callback interne de bail sont exclus. Les valeurs de headers/payloads ne sont pas révélées dans les raisons.

JSON et HTML exposent la même éligibilité. Quand elle échoue, les valeurs/deltas restent descriptifs, métriques improved=null, verdict inconclusive et absence de coloration directionnelle des deltas HTML. Les historiques incomplets ne récupèrent pas le contexte depuis une campagne modifiée. Une référence Git raccourcie ou dev ne satisfait pas le contrôle. Versions/conformité externes et fleet restent non enregistrées et empêchent leurs conclusions de comparaison ; le passage du builtin est une équivalence de champs enregistrés, pas une preuve causale ou d'identité de l'environnement.

Les fixtures positives de comparaison sont enrichies explicitement avec des preuves hypothétiques complètes ; elles ne certifient aucun runtime réel. Tests négatifs couvrent budget/profil/runtime/sonde différents, contexte absent, source dev, moteur externe, arrêt manuel, score estimé/NaN et assessment manquante. Les tests vérifient suppression du verdict amélioré et des indicateurs directionnels. Le tag différent seul conserve l'éligibilité ; un header fonctionnel différent la retire.

Validation : 35 tests ciblés compare/profil/contrat passent, puis neuf tests compare passent après durcissement et un test runner réel ciblé passe (11 autres ignorés par le filtre, sans les déclarer vérifiés). Typage backend/frontend, ESLint et Prettier passent. Quatre logs sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-run-comparability (0700/0600). Le contrat est décrit dans [run-comparison.md](./run-comparison.md). Les recettes réelles homogènes, le corpus externe/fleet et le gate complet restent requis. Sources locales seulement ; aucune promotion ni campagne cluster.

## Gate complet 07 et snapshot source-07

npm run verify termine exit 0 sur les sources figées : lint, typage backend/frontend, **1 077 tests backend passés / 26 conditionnels ignorés**, **408 tests frontend passés**, build complet. L'avertissement de taille bundle demeure. HEAD reste d98db08ecb520b4021df645e7aded44fe38ad939, sans commit/stash/reset/push.

Snapshot source-07 privé : 589 fichiers, 1 837 346 octets d’archive compressée, manifeste SHA-256 522c54b62e6f91b2d098ae5ad53048c101c899f72c4ea275bd80c65dd3b0e664, archive SHA-256 **926a8c9b6188371a9250a2cfe72614c90a6a5e9e5266599726280fb6373a6fb9**. Vérificateur indépendant valide archive/manifeste et les 589 fichiers. Le log du gate et le reçu sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-gate07 (0700/0600). L'archive est conservée sous .local/share/ddostester-source-snapshots. Ce gate précède les correctifs k6 révélés ci-dessous et ne les couvre pas ; il n'autorise pas une promotion après leur découverte.

## R09 — Binaire k6 réel et défaut de timeout

Le binaire privé [k6 2.3.0 officiel](https://github.com/grafana/k6/releases/tag/v2.3.0) macOS arm64 est téléchargé hors dépôt/PATH global. Archive 30 130 878 octets, SHA-256 b2417a3038edc5fe81dc178a889237724b595c5c9cfed875822008e46e862c7d, égal au checksum officiel et au digest de l'asset. Le manifeste officiel a lui-même le SHA-256 8ebbfcd5a13d68ac67d488c2b5f28bf901ea22d2fbbfb15f5345d65c39163be2. Le binaire n'est rendu exécutable qu'après contrôle ; SHA-256 efb8282e24ffe18f54ce3679eaa71d72e0645bbb97b14e2a05cc8b192abf48e3, version observée k6 v2.3.0 (commit/e088784614, go1.26.8, darwin/arm64). Reçu privé dans .local/share/ddostester-tools/k6-v2.3.0-macos-arm64.

Les recettes utilisent explicitement K6_BIN vers ce fichier et K6_NO_USAGE_REPORT=true, [option officielle de désactivation du rapport d'usage](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#no-usage-report), sans cible externe. La première recette réelle termine exit 1 : GET lent, absence de suivi de redirection, 503 et arrêt passent, mais timeout échoue. Un délai cible de 1 500 ms avec timeout demandé 1 000 ms rapporte quatre succès, car le script généré ne passait pas ce timeout à k6.

Le script ajoute un timeout explicite à tous les chemins de requête (simple, endpoints, flows ordinaires et corrélés), défaut 10 s comme builtin, entrées non finies/hors [1, 60 000] refusées. Les flows ordinaires conservent maintenant aussi les headers par étape, auparavant ignorés dans cette branche. 42 tests ciblés passent et la deuxième recette réelle termine exit 0 selon ses assertions initiales.

Son export révèle toutefois que les 302 sont classés succès par k6, contrairement au builtin (2xx uniquement). Le script utilise donc [http.expectedStatuses](https://grafana.com/docs/k6/latest/javascript-api/k6-http/expected-statuses/) pour aligner ce comptage sur 200–299 ; la recette exige désormais échecs sans succès pour la redirection comme pour 503/timeout. Les tests vérifient timeout sur flows ordinaires/corrélés, headers par étape, callback 2xx et refus d'Infinity. 43 tests ciblés passent, typage backend passe ; troisième recette réelle en cours. Source-07 n'inclut pas ces nouveaux correctifs. Aucune image cluster/production n'est promue.

La troisième recette réelle termine exit 0, cinq scénarios passés selon les assertions renforcées. Les trois exports/tentatives, logs, tests/types finaux et reçu de binaire sont conservés (neuf fichiers) avec manifeste SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-k6-real (0700/0600). Ce corpus est macOS/Node 26 sur GET simple, à 2 RPS/concurrence 2/durée 3 s ; les phases, flows réels, deadline sous tarpit et parité Linux restent à vérifier. Il n'est pas une conformité six moteurs, ni un passage global G3. Nouveau gate complet requis après ces correctifs avant promotion.

## R09 — Flow long, arrêt dur et issues HTTP non finalisées

Le mode extended de la recette ajoute trois GET avec think-time 2 s par étape à 1 RPS/3 s, et deux phases courtes 1 puis 2 RPS sur trois secondes. La première tentative termine exit 1 : le flow émet encore au-delà du budget + tolérance d'une seconde, puis termine vers 7,9 s. Les autres cas passent. Le [gracefulStop officiel de k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/graceful-stop/) laisse normalement les itérations finir ; sa valeur est désormais explicitement 0 s sur les deux exécuteurs.

La seconde tentative corrige le délai (tous les cas terminent vers 3,1 s, stop manuel vers 1,2 s), mais échoue sur les compteurs : des requêtes reçues par la cible sont omises des métriques HTTP lorsque l'itération est interrompue. Le script compte donc les tentatives avant chaque appel et les réponses 2xx réussies après retour. totalRequests représente les tentatives commencées, failed les tentatives sans succès enregistré ; aucun statut HTTP n'est inventé pour les issues non finalisées. Les anciens résumés sans nouveaux compteurs gardent leur décodage historique.

La troisième tentative révèle une tentative comptée avant émission, interrompue sans reçu cible (302 : sept tentatives / six reçus). La quatrième conserve donc explicitement finalizedRequests et unfinalizedRequests depuis les métriques finalisées. L'assertion est reformulée selon le contrat physique : finalized ≤ reçus ≤ tentatives, total=finalized+unfinalized ; elle ne prétend pas que toute tentative a atteint la cible. Les compteurs incohérents sont refusés. Les artefacts antérieurs ne sont pas réécrits.

Quatrième tentative exit 0, sept scénarios passés : bounded six tentatives / six reçus / cinq issues finalisées ; redirect six/six/six ; 503 six/six/cinq ; timeout quatre/quatre/trois ; stop trois/trois/deux ; flow deux/deux/une ; phases quatre/trois/deux. Flow et phases terminent environ 3,1 s, sans émission au-delà de la borne de recette. Les issues non finalisées restent inconnues, même lorsque le reçu cible est disponible. Cette recette n'est pas une preuve de plafond instantané de RPS, de corrélation ou de conformité complète des moteurs.

Les issues non finalisées rendent maintenant la confiance dégradée, sont visibles dans HTML/CSV/UI et interdisent une comparaison interprétée comme amélioration. Les statuts de campagne, caps et sonde indépendante ne sont pas modifiés. Tests compteur/délai/invariants : 42 passés ; après intégration confiance/export, 76 ciblés passés ; puis 33 rapport/confiance/comparaison passés, corpus partiellement commun. Typage backend/frontend, ESLint et Prettier passent. Treize artefacts couvrant les quatre tentatives et les validations sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-k6-flow-deadline (0700/0600).

La documentation de recette est actualisée. Les sources restent locales, hors snapshot source-07 et images source-06/production. Gate complet 08 préparé après corrections ; aucune promotion ni campagne cluster dans cette étape.

## Gate complet 08 et préparation Vegeta

Le gate complet 08 termine exit 0 sur les sources figées : lint, typage backend/frontend, **1 082 tests backend passés / 26 conditionnels ignorés**, **408 tests frontend passés**, build complet. L'avertissement de taille bundle reste présent. Ce gate inclut les corrections timeout/302/deadline, compteurs commencés/finalisés, exports et confiance. Il ne remplace pas les recettes réelles ni les suites conditionnelles ignorées.

Snapshot source-08 : 589 fichiers, 1 842 488 octets d’archive compressée, manifeste SHA-256 a2ddcc86f197c40ad417983f5e3c68df25122efe7344910848313486660821e6, archive SHA-256 **6af4210c33925a56e91d0d4c728eb0f1a5dab54f945c46888d985067b8b2db32**. Le vérificateur indépendant valide archive/manifeste et les 589 fichiers. Le log complet et le reçu sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-gate08 (0700/0600). HEAD inchangé, aucune opération Git destructive ni promotion.

Le binaire Vegeta v12.13.0 est préparé hors PATH global depuis [l'archive officielle](https://github.com/tsenart/vegeta/releases/tag/v12.13.0), arm64 Darwin. Archive 4 120 537 octets, SHA-256 fc408e242c4f4839e6fe536dbf1130bb02f430134827f6d831bf367a0929a799, vérifié contre le manifeste officiel et le digest d'asset. Manifeste SHA-256 384239c939594c6a4e3b1da4b336728a0d70ed8e77636af92984cdf036a816e7. Binaire extrait seul, rendu exécutable après vérification, SHA-256 15d6cd01fc412e70a11243006de4e5fd68d505a13848ae3312d83d49b64fd087. Version observée v12.13.0, commit 507c4f028fbad80168f3b734dab9530d3aabfefa, Go 1.22.12 darwin/arm64. Reçu privé copié dans le dossier gate08 (trois artefacts au total).

Une recette Vegeta réelle extended est lancée vers sa cible loopback dédiée, avec VEGETA_BIN explicite vers ce fichier. Elle reste en cours à cette écriture ; aucune conformité n'est encore déclarée pour ce moteur. Production reste build 451 et cluster Linux sur source-06. Source-08 est un candidat local vérifié, sans image runtime construite/promue dans cette étape.

Cette recette Vegeta termine ensuite exit 0 : six scénarios pris en charge passent, tandis que flow reste explicitement unsupported/not-validated. Les exports/logs sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-vegeta-real (0700/0600). Cette preuve porte sur macOS, le GET borné et deux phases courtes ; elle ne prouve pas les flows (non pris en charge), la parité Linux ni une conformité six moteurs. Aucun correctif source supplémentaire n'est nécessaire à partir de cette recette ; source-08 demeure le candidat runtime de cette étape.

## R09 — Fenêtres Vegeta et limites fractionnaires

Le temps global de la première recette (phases : 4 280 ms pour trois secondes demandées) révèle l'addition des attentes de réponse et de traitement de rapports entre phases. Les fenêtres sont désormais ancrées sur une horloge monotone et leurs échéances cumulées initiales. Le drain/traitement consomme la fenêtre suivante sans augmenter les caps. Deuxième recette : phases 3 796 ms, quatre reçus au lieu de cinq, tous rapportés. Les durées sont arrondies vers le bas à la milliseconde.

Le partage de taux arrondissait aussi 0,5 RPS à 1 RPS. Troisième recette : trois reçus espacés de 998/1 000 ms, assertion de pacing en échec. splitRate conserve ensuite les parts fractionnaires ; une fréquence entière par période en nanosecondes encode 0,5 RPS comme 1/2 s, sans fréquence zéro. Le [pacer officiel](https://raw.githubusercontent.com/tsenart/vegeta/v12.13.0/lib/pacer.go) fournit ce contrat fréquence/période.

Quatrième recette : pacing corrigé (deux reçus espacés de 1 998 ms), mais émission après la borne. Le [code officiel](https://raw.githubusercontent.com/tsenart/vegeta/v12.13.0/lib/attack.go) vérifie la durée avant le sleep de pacing. Le driver réserve donc un intervalle complet et attend le début prévu de chaque phase. Une fenêtre trop courte est sautée ; la sous-émission reste réelle, sans compensation du débit ni déclenchement précoce de la phase suivante.

Cinquième recette exit 0 : sept scénarios pris en charge passent, flow reste unsupported. Phases : 3 171 ms, trois reçus/rapports, gaps 500/499 ms ; le premier palier court n'est pas garanti exercé. Fractionnaire : cinq secondes demandées, deux reçus/rapports espacés de 1 999 ms, terminaison 4 655 ms. Ces résultats ne certifient pas toutes les intensités de phases ni un plafond instantané universel.

Après cette recette, une garde supprime les fenêtres qui s'arrondissent à zéro ; le builder refuse explicitement cette durée, qui signifie illimité pour Vegeta. Vingt-huit tests ciblés passent, typage backend, ESLint et Prettier passent. La recette précédente couvre les fenêtres positives inchangées ; la garde zéro a un test dédié. Dix artefacts des tentatives 02–05 et tests/types finaux sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-13-vegeta-windows-and-fractions (0700/0600).

README de recette actualisé. Correctifs locaux postérieurs à source-08/gate08 ; nouveau gate complet requis avant image/promotion. Production et cluster Linux restent inchangés.

## 14 octobre — R08, percentiles Vegeta entre phases

mergeResults utilisait une moyenne pondérée des p50/p95/p99 de phases, qui ne représente pas les percentiles de la population agrégée. Le chemin réel conserve désormais les fichiers de résultats de chaque processus/phase puis demande un rapport natif unique sur l'ensemble des observations. Le [reporter officiel](https://raw.githubusercontent.com/tsenart/vegeta/v12.13.0/report.go) accepte plusieurs fichiers ; les [métriques natives](https://raw.githubusercontent.com/tsenart/vegeta/v12.13.0/lib/metrics.go) calculent les quantiles à partir des observations, avec leur estimateur natif. Il ne s'agit pas de percentiles exacts nearest-rank.

Le helper pur ne fusionne plus des percentiles seuls : il exige des histogrammes communs complets, compteurs cohérents, puis utilise les bornes supérieures de buckets. Une absence ou un overflow reste une erreur, pas une moyenne inventée. Son test de distribution distingue un p95 de bucket 25 ms d'une moyenne de percentiles. Le chemin natif n'utilise plus ce helper : il recompute les métriques sur les résultats binaires conservés. Le débit global est aussi calculé sur le temps monotone complet du driver, incluant démarrage/drain/rapport, sans remplacer la fenêtre par le seul intervalle entre arrivées.

La recette extended ajoute distribution : deux phases de deux secondes à 2 RPS, cible répondant vite aux trois premiers reçus puis avec délai 500 ms aux suivants. Recette réelle exit 0 ; cas distribution six reçus/six rapports, mean=255,65 ms, p95=506,93 ms, durée 4 085 ms. Le p95 de cette population reste près de la partie lente ; une moyenne de percentiles de phases l'aurait rapproché de la moyenne et échouerait l'assertion >=400 ms. Cette preuve est locale macOS et ne vaut pas conformité de tous les moteurs ou G3 complet.

Le résultat conserve latencyMethod, exposé dans HTML et CSV ; les historiques sans ce champ ne sont pas étiquetés rétroactivement. Quarante-huit tests ciblés passent, typage backend/frontend, ESLint et Prettier passent. Quatre artefacts réel/log/types/tests sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-14-vegeta-quantiles (0700/0600). Sources postérieures à source-08, nouveau gate complet requis ; images et production inchangées.

## Gate 09, snapshot identifié et compilation native Linux

Gate complet 09 terminal exit 0 : lint, typage backend/frontend, **1 086 tests backend passés / 26 conditionnels ignorés**, **408 tests frontend passés**, build complet. L'avertissement de taille bundle demeure. Après ce gate, deux libellés du journal sont corrigés : les tailles des snapshots 07/08 sont des octets d'archive compressée, pas le volume décompressé. Cette correction documentaire passe Prettier ; sources applicatives et tests restent ceux du gate.

Source-09 : 589 fichiers, archive compressée **1 846 686 octets**, manifeste SHA-256 **791a6c72ec03200f3e1bf7dd9ec07f70f6dd3beadc13614cd03201480d5ef885**, archive SHA-256 **58fe7194665d918f63880aeee17d15defe1d89574379ffbeed6a85936a6e8a56**. Vérification indépendante locale puis sur le VPS : archive/manifeste et les 589 fichiers valides, HEAD d98db08ecb520b4021df645e7aded44fe38ad939 inchangé. Log et reçu archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-14-gate09 (0700/0600).

L'archive est transférée dans le répertoire privé neuf /var/lib/ddostester-linux-lab-attempt-03/control-source-09. Extraction seulement après vérification, sans remplacer un contexte existant ; source /tmp/ddostester-source-09 copiée dans le builder identifié. Le builder est running, image BuildKit attendue, limites 0,5 CPU / 1,5 Gio ; espace hôte disponible environ 42 Gio et absence de Jobs observée avant préparation. Export lancé sous ddostester-native-export-09.service avec RuntimeMaxSec=900, CPUQuota=50%, MemoryMax=1536M.

Observation live : MainPID=670587, active/running. ExecMainStatus=0 à cet instant ne signifie pas terminaison. La compilation backend aboutit avec référence snapshot:58fe7194… complète ; frontend encore actif. Le builder a été observé à environ 51,72% CPU dans la fenêtre d'échantillonnage et 621,8 Mio / 1,5 Gio, sans relever ses limites. L'export se poursuit indépendamment de la session SSH ; image/OCI ne sont pas encore déclarés construits ou importés. Aucun déploiement ni compte modifié.

## Source-09 — Export terminal et vérification isolée de l'image

L'unité native termine ensuite avec MainPID=0, ExecMainStatus=0, inactive/dead. Build backend/frontend, prune et garde portable réussis. OCI **69 272 064 octets**, SHA-256 **264db3d5ea182f226266c95084b66d5c3e79a2f8f9de7d30e60c8cd923a2c48d** ; source archive 58fe7194… complète dans son reçu. Image **docker.io/library/ddostester-lab-control@sha256:5c22af40707d6c47bd1be21aebba25bbfa58e3e1954555ed6bae615d411c0dd9**.

L'import control-only vérifie nœud/purpose, absence de Jobs agents, taille/checksum, noms/platform/config/manifeste OCI, puis charge une seule image amd64 dans le cache. Les références de déploiements existantes ne sont pas modifiées. L'alias local du cache est actualisé par le helper ; le contrôle courant reste explicitement épinglé sur 5a50d822… (source-06), vérifié après nettoyage.

Un Job éphémère lab-release-smoke-09 teste le serveur compilé et les assets du manifeste via loopback. UID **dc002e0a-a0e7-4ddc-9b0e-fe83f274a6bb**, Pod UID **895bbcf4-5064-4d26-a205-85f97f27ac49**, imageID identique au digest candidat. Non-root 1000, seccomp RuntimeDefault, capabilities supprimées, racine read-only, token SA non monté, tmp borné 32 Mio ; limites 250m / 256 Mi, backoff 0, deadline 120 s. Stockage mémoire, USER_MODE=team, scheduler off et flotte désactivée : ce test ne touche aucune base persistante et ne valide pas le mode single/PostgreSQL ou l'authentification réelle.

Le Job termine succeeded=1 en environ 29 s. Le vérificateur confirme API/UI snapshot:58fe7194665d918f63880aeee17d15defe1d89574379ffbeed6a85936a6e8a56 build lab avec les checksums d'assets. Job/Pod/logs sont sauvegardés avant suppression avec précondition atomique sur l'UID. Lecture suivante : Job et Pods de cet UID absents, déploiement lab-control toujours source-06.

Sept preuves/logs build/import/smoke/delete sont archivés avec SHA-256 revérifié dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-14-linux-source09 (0700/0600). Candidat Linux prêt pour les validations d'intégration restantes ; aucune promotion du contrôle existant ni modification de comptes ou campagne produit. Production reste build 451.

## R03/R10 — Sauvegarde chiffrée du laboratoire et restauration isolée

La base dédiée ddostester_lab est sauvegardée via le helper database-backup.mjs et un pont PostgreSQL privé, scripts/operations/kubernetes-pg-tool.py. Le pont vérifie l’identité du nœud Docker et son label isolated-linux-lab, limite le dump à cette base et la restauration à un nom de base temporaire explicite. Il conserve les flags de restauration transactionnelle et transmet le dump vérifié par stdin, sans fichier en clair dans le Pod. Ce helper opérationnel est postérieur au snapshot source-09 ; il ne fait pas partie de cette image.

Archive AES-256-GCM : **65 787 octets**, dump **65 738 octets**, SHA-256 **47627510543970461c0577cc6f9052b363f197f6b85133133055f99384096b2f**. Une clé indépendante de 32 octets est conservée hors Git avec l’archive et les reçus dans des répertoires privés 0700/0600. La copie Mac /Users/abdelhatayeb/.local/share/ddostester-lab-backups/2026-10-14-01 est entièrement reçue : six fichiers, permissions, taille, checksum de l’archive et longueur de clé vérifiés ; manifeste privé SHA256-manifest.json créé et revérifié. Cette copie protège contre la perte du VPS ; clé et archive étant colocalisées, elle ne constitue pas une séparation cryptographique des détenteurs.

Restauration authentifiée en transaction dans ddostester_lab_restore_f81177d530c8, OID **16570**, PostgreSQL 16.15. Le compte unique, ses credentials et versions de session sont identiques à la source ; les **126 lignes d’audit** sont également identiques. Cela prouve la conservation des lignes, pas encore la validité de leur chaîne cryptographique ni le fonctionnement de l’application restaurée. La base source demeure présente.

Une copie chiffrée volontairement altérée est rejetée avant tout appel PostgreSQL, vérifié par des outils témoins ; elle est ensuite supprimée. La base temporaire est retenue pour l’intégration isolée du candidat source-09. Les reçus de restauration, intégrité et identité de cette base sont conservés dans l’escrow Mac et sur le VPS. Aucun compte de production, contrôle courant ou campagne n’est modifié. Validation restante : application single/PostgreSQL sur cette copie, chaîne d’audit, puis nettoyage avec garde de nom/OID et absence de connexions étrangères.

## Source-09 — Application single/PostgreSQL après restauration

Job isolé lab-restore-check-09, UID **37f1e4b1-7a6b-4d0f-9ccf-0b6c5edcde95**, connecté uniquement à la base restaurée ddostester_lab_restore_f81177d530c8 après garde de nom/OID 16570. ImageID réel identique au candidat **5c22af40707d6c47bd1be21aebba25bbfa58e3e1954555ed6bae615d411c0dd9**. Secret éphémère indépendant pour la signature JWT, password du compte de laboratoire référencé sans exposition dans manifeste/log ; aucun bootstrap ni changement de credentials.

Pod non-root, seccomp, capabilities supprimées, racine read-only, pas de token de service account ; tmp 32 Mio, limites 250m/256 Mi, deadline 150 s, aucun retry. Label distinct du Service de contrôle ; API en loopback, ingress interdit et egress limité à PostgreSQL par NetworkPolicy, URL de base sur IP Service sans DNS. Scheduler et flotte désactivés.

Job terminé succeeded=1 : readiness, accès non authentifié rejeté 401, login propriétaire admin, permissions campaign:create/approve/execute, user:manage et limits:manage présentes, JWT **3 600 secondes**, référence snapshot source-09 exacte. La chaîne d’audit et l’export sont valides avec **128 entrées** après démarrage/login sur la copie restaurée. Cette preuve valide la lecture authentifiée et le contrat de capacités ; elle ne constitue pas un nouveau corpus complet des mutations utilisateurs ni un lancement de campagne.

Manifest Job, Pods, log de verdict, script de préparation sans secrets et reçus de création/suppression sont copiés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-14-restored-app (0700/0600), six artefacts avec manifeste SHA-256 revérifié. Suppression du Job, Secret et des deux politiques via préconditions atomiques UID. La base restaurée est encore conservée pour les contrôles historiques et son nettoyage gardé ; contrôle source-06 et production non promus.

## R10 — Historiques restaurés et nettoyage final

Comparaison SQL des lignes complètes, sans exporter leurs contenus : **10 campagnes, 8 runs, 8 échantillons WRS** identiques entre source et restauration après le test applicatif. Playbooks, targets, bench_runs et bench_coverage sont identiques mais vides : cela ne valide pas une restauration de données non vides dans ces quatre tables. Les valeurs intermédiaires de comparaison restent internes à PostgreSQL.

Lecture après suppression : Job, Pod, Secret et politiques de test absents ; référence lab-control source-06 inchangée. Base temporaire supprimée seulement après garde nom ddostester_lab_restore_f81177d530c8 / OID 16570 et zéro connexion, commande DROP générée conditionnellement par PostgreSQL, puis absence de cette base vérifiée. Base source présente avec 10 campagnes. Trois reçus supplémentaires archivés avec SHA256-history-manifest.json dans le dossier privé restored-app ; les six preuves et leur manifeste antérieurs sont préservés.

## R05/R08 — Préparation de la collecte Kubernetes

Overlay séparé deploy/kubernetes/monitoring : Prometheus 3.15.0 et Grafana 13.2.4, versions officielles consultées le 14 octobre, index Docker multiarchitecture résolus et épinglés par digest. Collecte contrôle/self, provisioning des dashboards existants, PVC distincts, rétention Prometheus 7 jours/1 GB de blocs, non-root/read-only/seccomp, budgets 400m CPU/768 Mi cumulés et règles réseau limitées. Secret admin référencé sans valeur dans Git, accès par port-forward loopback seulement. Documentation des limites WAL/disque local-path et filtrage L3/L4.

Kustomize rend les manifests avec succès et Prettier passe. Aucun déploiement de ces collecteurs à cette étape : promtool réel, validation serveur, collecte, UI et persistance restent requis. Ces fichiers sont postérieurs au snapshot source-09 et ne constituent pas une nouvelle image applicative.

## Monitoring 01 — Validation serveur et installation privée

État vérifié avant installation : cinq workloads du laboratoire disponibles, aucun Job, StorageClass local-path par défaut, mémoire hôte disponible environ 5,8 Gio. HEAD reste d98db08ecb520b4021df645e7aded44fe38ad939. Rendu Kustomize transféré ; validation serveur dry-run des 13 ressources acceptée, sans avertissement Pod Security.

Prometheus 3.15.0 téléchargé par digest. Premier promtool non-root : permission denied sur le fichier de configuration monté 0600 ; aucun succès revendiqué. Permission du seul fichier sans secret ajustée à 0644 dans le répertoire hôte privé, deuxième contrôle avec réseau none, racine read-only et limites 0,2 CPU/256 Mi : config syntax valid, exit 0.

Installation par create, sans remplacer de ressources existantes, après vérification du nœud/purpose, absence des deux déploiements/Secret et du témoin promtool réussi. Secret aléatoire dédié immutable, credentials dans /var/lib/ddostester-linux-lab-attempt-03/monitoring-01/credentials.json (0600, répertoire 0700), aucune valeur dans Git/log/arguments. Les 13 ressources monitoring sont créées. PVC Prometheus 2 Gi et Grafana 512 Mi Bound ; à la première observation, Pods encore Pending/ContainerCreating, aucun événement Warning. Readiness, collecte, accès et persistance ne sont pas encore déclarés validés.

Observation suivante : rollout Prometheus réussi. API /api/v1/targets retourne deux cibles active health=up (lab-control et lab-prometheus), lastError vide, scrapes 15 s, environ 260/304 ms lors de cette observation. Grafana demeure ContainerCreating, sans preuve de disponibilité ou d’accès à ce stade. État des targets/Pods/PVC archivé privément dans monitoring-01 ; aucun remplacement de Pod sur simple attente. Nouveau vérificateur scripts/operations/verify-lab-monitoring.mjs préparé pour un Pod de recette isolé : endpoints IP privées, accès anonyme refusé, admin/datasource/dashboards et scrape up. Syntaxe et format passent ; ce vérificateur n’est pas encore exécuté.

## Monitoring 01 — Initialisation Grafana et préparation de recette

Lecture suivante : téléchargement terminé du digest Grafana attendu (482 597 495 octets, environ 2 min 12 s), conteneur Running, zéro restart, IP privée 10.247.0.60. Migrations SQLite exécutées avec succès, puis enregistrement des plugins intégrés sous quota 200m CPU. Le rollout observé pendant 45 secondes expire avant readiness ; cela n’est pas un état terminal du Pod et aucun remplacement/retry n’est effectué.

Recette préparée dans monitoring-01/check.py et verify.mjs : Job non-root sur le candidat source-09, réseau limité par trois politiques temporaires vers les IP Services Prometheus/Grafana, secret admin référencé sans contenu exposé, deadline 60 s, backoff 0. Création conditionnée à availableReplicas=1 des deux collecteurs et absence du Job de même nom. Le test reste à exécuter après readiness ; aucun succès d’authentification ou de provisioning ne découle des seuls logs de migration.

## Monitoring 01 — Recette authentifiée et règle de collecte

Grafana devient disponible après initialisation, sans relever son quota CPU. Job lab-monitoring-check-01 UID **6b3669ce-0d6e-4b42-8fbc-e1d4afb76adc**, candidat source-09, non-root, réseau restreint, deadline 60 s/backoff 0, termine succeeded=1. Verdict : deux targets up, contrôle up, DB Grafana saine, accès anonyme /api/user rejeté 401, compte lab-admin authentifié, datasource UID prometheus vers lab-prometheus, dashboards shieldtest-run/shieldtest-resilience présents avec panneaux. Cela prouve le provisioning/API, pas encore le rendu visuel ni la présence de toutes les séries de chaque panneau.

Job/Pods/log/UID des trois politiques temporaires archivés avant suppression atomique gardée par UID. Collecteurs persistants conservés. Nouvelle règle LabControlScrapeUnavailable avec for=1m : up=0 ou absent. Premier test réel promtool échoue faute de /tmp inscriptible dans la racine read-only ; deuxième exécution utilise tmpfs 32 Mio, réseau none et limites inchangées, termine SUCCESS pour les trois fixtures up/down/absent. Logs des deux tentatives conservés.

Règle et config Kustomize mises à jour localement, rendu réussi ; elles ne sont pas encore activées dans le déploiement existant. Aucun destinataire Alertmanager externe n’est configuré. Activation, vérification de la règle live, persistance après recréation et refus réseau restent ouverts.

Douze artefacts de création/état initial/recette/suppression/tests sont copiés dans /Users/abdelhatayeb/.local/share/ddostester-lab-evidence/2026-10-14-monitoring-01, permissions 0700/0600 et manifeste SHA-256 revérifié. Aucun fichier credentials n’est inclus dans ce corpus.

## Monitoring 01 — Règle active et persistance Prometheus

Activation limitée à un nouveau ConfigMap et au nom du volume config du déploiement Prometheus, avec préconditions JSON patch UID/resourceVersion/ancienne référence. Aucun changement de CPU/PVC, contrôle ou Grafana. Requête historique up du contrôle et identités Pod/PVC capturées avant modification. Rollout terminal réussi.

Après recréation : Pod UID initial **08ab86b1-97d1-48d4-b4f3-d95da0ab894a**, nouveau **aa814155-b60c-47e4-8124-0fa2bd313173**, PVC UID inchangé et Bound. Requête au temps exact **1791935916.415** retourne les mêmes labels/valeurs que la référence : conservation vérifiée d’un échantillon historique après redémarrage, pas encore d’un corpus de longue rétention ou d’un sinistre hôte. Règle LabControlScrapeUnavailable chargée health=ok, state=inactive.

La première assertion de configuration effective échoue sur la représentation textuelle : Prometheus normalise 7d en **1w** et 1GB en **1GiB**. Inspection de /api/v1/status/config confirme ces valeurs équivalentes ; assertion corrigée et vérification terminale réussie, sans modifier la rétention demandée. Preuve privée persistence-and-rule-proof.json. Restent : déclenchement/résolution live contrôlés, persistance Grafana et recette complète réseau/alertes.

Quatre preuves avant/activation/après copiées dans le corpus monitoring-01 privé, avec SHA256-persistence-manifest.json revérifié ; le manifeste des douze artefacts précédents reste préservé.

## Monitoring 01 — Recette live de collecte interrompue

Recette lancée dans ddostester-lab-alert-live-01.service (RuntimeMaxSec=480, CPUQuota=50%, MemoryMax=256M), MainPID **693650** observé active/running ; ExecMainStatus=0 à cet instant ne prouve pas la terminaison. Avant modification, nœud/purpose, disponibilité Prometheus et commande HUP sont vérifiés. Configuration originale et UID ConfigMap sauvegardés, puis timer indépendant ddostester-lab-alert-rollback-01 armé à 240 secondes avant l’injection.

Injection limitée au metrics_path du scrape lab-control, remplacé par un chemin dédié donnant 404 ; aucun arrêt ni campagne cible. JSON patch garde l’UID et le contenu attendu. Le script attend la projection du ConfigMap avant HUP, observe down/pending/firing, puis restaure le contenu original et recharge. Le rollback indépendant répète cette restauration de manière idempotente si nécessaire, refuse un contenu tiers et attend la projection avant HUP. À cette étape, l’exécution est encore live ; déclenchement/résolution et restauration ne sont pas encore déclarés acquis.

## Monitoring 01 — Alerte déclenchée puis résolue

Projection de la configuration fautive confirmée dans le Pod, puis scrape contrôle down avec HTTP 404 sur le chemin dédié ; scrape Prometheus toujours up. API alerts observée pending, puis firing. Unité principale termine MainPID=0, inactive/dead, ExecMainStatus=0 ; reçu terminal confirme downObserved/firingObserved/configRestored. Cette recette valide une panne de collecte injectée, pas une panne de l’application ou de la cible.

Après restauration, vérification du contenu exact ConfigMap gardé par UID et du fichier Pod : identiques à l’original. API targets : URL /metrics originale, health=up, lastError vide. API rules : state=inactive, health=ok. La résolution est donc observée, pas déduite de la seule commande de reload. Aucun destinataire externe n’a reçu de notification ; aucun compte ni campagne modifié. Timer de restauration indépendant conservé pour sa vérification terminale/idempotente.

Cinq artefacts observations/terminal/résolution/log/statut unités copiés dans le corpus privé monitoring-01, permissions revérifiées et SHA256-alert-live-manifest.json conservé séparément des manifestes précédents.

## Monitoring 01 — Marqueur Grafana et rollback terminal

Journal systemd du rollback indépendant : service lancé à 02:05:26 heure VPS, « Scrape configuration restored or already original », deactivated successfully à 02:05:29. Le timer/service transient n’est ensuite plus chargé ; les timestamps vides de systemctl show ne prouvaient donc pas une non-exécution. Journal inspecté pour établir sa terminaison et l’idempotence après restauration principale.

Vérificateur scripts/operations/verify-grafana-persistence.mjs créé : origine privée, authentification via Secret, réponse bornée, phases create/verify/cleanup, nonce distinct et suppression limitée à l’annotation qui correspond à son identifiant/texte/tag. Syntaxe et Prettier passent. API legacy annotations consultée dans la documentation officielle Grafana : disponible en v13, dépréciée sans remplacement équivalent annoncé pour annotations.

Job lab-grafana-persistence-create-01 UID **be0bfc93-0325-42cb-9336-7ed1a417dfdc** enregistre et relit l’annotation **id=1**, tag/texte **ddostester-persistence-ea735a12-9225-4a12-a87f-e5b81a9a45a6**. Cela prouve un marqueur en base avant redémarrage ; la conservation après recréation du Pod n’est pas encore validée. Le marqueur reste en place pour la suite, sans modifier les dashboards provisionnés.

## Monitoring 01 — Recréation gardée de Grafana

Avant suppression, marqueur id=1 vérifié, Job de création nettoyé, un seul Pod Grafana Running et PVC Bound. Identités/configuration du Pod et PVC sauvegardées dans grafana-before-recreate.json. Suppression du seul Pod avec précondition UID **9027d635-a94d-4d8f-bcd3-0dfd6112a337**, sans toucher Deployment/PVC/Secret. Nouveau Pod lab-grafana-6659898cd6-xxpn8, IP **10.247.0.65**, Running, zéro restart, initialisation des plugins en cours.

Premier délai d’observation 55 s expiré ; Pod conservé, deuxième observation de la même disponibilité lancée. Job de lecture préparé sous nom distinct lab-grafana-persistence-verify-01, conditionné à la disponibilité. Aucun succès de persistance après recréation n’est déclaré tant que ce Job n’a pas relu exactement id/texte/tag du marqueur.

## Monitoring 01 — Persistance Grafana vérifiée

Job lab-grafana-persistence-verify-01 UID **3ed2f7d6-c7cb-45a7-87ae-1706a04b7ff4** termine succeeded=1 : annotation id=1, même texte/tag unique qu’avant recréation. Ancien Pod UID **9027d635-a94d-4d8f-bcd3-0dfd6112a337**, nouveau **f96fb681-2d31-46d6-9fb5-9d7111876896** ; PVC UID inchangé, Bound, même image, nouveau Pod Ready. Preuve grafana-persistence-proof.json. Job et politiques de lecture supprimés avec gardes UID après archivage.

Job cleanup distinct UID **83a80d23-640f-422c-972a-e349eae927d1** termine succeeded=1 après revalidation id/texte/tag, DELETE de cette seule annotation et GET confirmant son absence. Le premier helper d’archivage tente un nom de log déjà présent : FileExistsError protège la preuve verify, sans écrasement ; fichiers partiels conservés. Archivage repris sous noms distincts sur le même Job terminé, sans rejouer l’annotation ou le test.

La recette couvre une donnée SQLite applicative conservée via PVC après recréation du Pod. Elle ne prouve ni résilience du disque hôte, ni sauvegarde/restauration Grafana, ni rendu visuel de tous les panneaux.

Dix artefacts avant/après/vérification/nettoyage copiés dans le corpus privé monitoring-01, SHA256-grafana-persistence-manifest.json revérifié et manifestes précédents préservés.

## R08 — Métriques persistées de flotte et dashboard

Audit de /metrics : aucun export de flotte persistée. Nouveau renderFleetMetrics sur les runs réellement enregistrés, branché dans la route existante : une dernière flotte par origine cible, sélection sur finishedAt valide indépendamment de l’ordre du store, tie-break déterministe sans label runId. Origine HTTP(S) sans credentials/path/query ; schéma et port conservés pour distinguer les destinations.

Gauges : timestamp du résultat, complétude enregistrée, coverage_known, agents rapportés/attendus quand une couverture received-final-results-only cohérente est disponible, requêtes des résultats reçus. L’historique absent ne reçoit pas un nombre inventé ; une flotte incomplète expose explicitement un sous-ensemble de compteurs. Une couverture manquante du dernier run ne reprend pas les valeurs d’un ancien run complet. Pas de pseudo-compteur monotone par run, ni identité d’agent ou secret dans les labels.

Quatre nouveaux tests couvrent suppression des secrets/paths, flotte incomplète, ordre historique et absence/incohérence de couverture, timestamp invalide. Avec les tests runtime : sept tests passent. Typage backend et ESLint passent. Une erreur initiale de champ config.target est détectée par TypeScript et corrigée vers config.url avant validation.

Dashboard local 03-fleet.json, six panneaux sur ces gauges, absence laissée vide et description du sous-ensemble/ancienneté. ConfigMap Kustomize inclut ce dashboard ; rendu réussi. Sources applicatives postérieures au gate/snapshot source-09 : nouveau gate complet et image requis. Aucun export de ces nouvelles séries ou déploiement de ce dashboard n’est encore revendiqué sur le cluster source-06 ou production.

## Gate 10 — Flotte persistée et monitoring

Gate complet npm run verify terminal exit 0 : lint, typage backend/frontend, **1 090 tests backend passés / 26 conditionnels ignorés**, **408 tests frontend passés**, builds backend/frontend réussis. Avertissement bundle >500 kB conservé. Aucun succès de suites PostgreSQL conditionnelles n’est déduit de leurs skips.

Les sources applicatives ont été conservées inchangées pendant le gate. Le builder Linux est Running avec image BuildKit attendue, Memory=1 610 612 736, CpuQuota=50 000/CpuPeriod=100 000 ; aucun Job de laboratoire observé. Nouveau snapshot source-10 à capturer après ce bilan documentaire, puis vérification indépendante et compilation native nécessaires avant import/promotion. Production reste build 451, contrôle laboratoire source-06.

## Source-10 — Snapshot vérifié et compilation native lancée

Snapshot privé source-10 : **605 fichiers**, archive compressée **1 867 562 octets**, manifeste SHA-256 **f3d34018fa5e633a07db5de5bc41b081f9ea489d8798fa377942a24edf45add4**, archive SHA-256 **dcca4871527ebc65bb630473cfa483f2c636a78bc40943682f7125eba3c8aaa5**. Vérification indépendante locale puis VPS : archive/manifeste et 605 fichiers valides, HEAD d98db08ecb520b4021df645e7aded44fe38ad939 préservé. Log/résultat gate et reçu source-10 sont archivés dans le dossier privé 2026-10-14-gate10 avec SHA256-manifest.json revérifié.

Nouveau répertoire privé control-source-10, extraction après vérification dans /tmp/ddostester-source-10 sans remplacer de contexte, puis copie vers un répertoire neuf du builder borné. Compilation lancée via ddostester-native-export-10.service, RuntimeMaxSec=900, CPUQuota=50%, MemoryMax=1536M. Observation live : MainPID **706201**, active/running, étape build backend démarrée. ExecMainStatus=0 à cet instant ne vaut pas réussite terminale ; aucune image/OCI/import n’est encore revendiqué. Contrôle source-06 et production inchangés. Cet addendum documentaire est postérieur à la capture ; sources applicatives restent celles du gate 10.

## Gate PostgreSQL local sur source-10

Base de tests distincte via l’image PostgreSQL déjà présente, identifiée par son ID immutable, sans téléchargement. Première tentative : PostgreSQL démarre sur réseau Docker internal, mais NetworkSettings.Ports reste vide malgré la demande loopback ; aucun test lancé. Tentative conservée dans attempt01.json, conteneur/réseau propres supprimés après vérification ID/label.

Deuxième instance jetable sur bridge dédié, port publié uniquement **127.0.0.1:64095**, PostgreSQL **16.15 Debian aarch64** ; non-root 999, racine read-only, tmpfs bornés, capabilities supprimées, 0,5 CPU/512 Mi. Ce bridge n’est pas déclaré comme une interdiction d’egress. Credentials aléatoires transmis par fichier 0600 hors Git et environnement de sous-processus, aucune valeur dans logs/arguments. Aucun accès aux bases du laboratoire/production.

REQUIRE_POSTGRES_TESTS=1 : **5 fichiers / 37 tests passent**, couvrant les contrats store, garanties PostgreSQL, coordination durable, récupération du propriétaire et budgets assistant. recovery-check.mjs termine exit 0 : sauvegarde chiffrée, restauration authentifiée transactionnelle, comptes/versions de sessions et lignes d’audit conservés, archive altérée refusée avant appel PostgreSQL. Cela ne remplace pas la vérification cryptographique de chaîne déjà faite sur la restauration du laboratoire.

Exécution sous **Node 26.8.1 macOS**, pas le gate CI Node 22. Instance et réseau supprimés avec vérification ID/label/absence, credentials temporaires effacés ; cinq artefacts privés avec SHA256-manifest.json revérifié dans 2026-10-14-postgres-gate10. Sources applicatives restent celles du gate/source-10. Compilation Linux observée encore active : backend abouti à l’étape frontend, aucune réussite terminale/image/import encore revendiquée.

## Source-10 — Export Linux terminal et cache vérifié

Unité native terminale MainPID=0, inactive/dead, ExecMainStatus=0. OCI **69 273 600 octets**, SHA-256 **fa35090927330d8c195f691a029efb6ab2610ea16ae79ab27eef5acaa2c9f07d**, provenance source dcca4871… complète vérifiée avant import. Helper control-only vérifie nœud/purpose, absence de Jobs agents, taille/checksum et métadonnées OCI amd64 ; une image importée dans le cache : **docker.io/library/ddostester-lab-control@sha256:66e14184eecf56b514aef0f8397a329b83bce1e7308b3d425730b89e7a31143d**. Alias local du cache actualisé, références des workloads non modifiées.

Trois preuves export/log/import copiées dans 2026-10-14-linux-source10 privé, SHA256-manifest.json revérifié. Pas encore de smoke/intégration/promotion source-10 ; la recette Locust ci-dessous révèle ensuite des corrections postérieures requises.

## R09 — Locust réel et absence de faux résultats zéro

Source officielle PyPI : Locust **2.46.7**, Python >=3.11. Python système 3.9.6 conservé ; environnement privé utilisant le runtime Python 3.12.14 fourni. Installation limitée aux wheels téléchargées depuis PyPI, installation ensuite offline, 37 archives avec SHA-256 et versions gelées dans le reçu. Wheel principal SHA-256 **a737bcf8d6728d4f0efe9e460ef9c69d0084e1dd085734db6e4775ece453b7fe** comparé aux métadonnées officielles. PATH/global Python inchangés.

Première recette loopback exit 1 : cinq scénarios sans reçu, chacun retournant pourtant un résultat zéro sans erreur. Préflight --list confirme la cause : User.run est réservé et ne peut être une tâche. Deux chemins du builder renommés send_requests. Parser refuse désormais une agrégation absente ou des compteurs invalides/contradictoires au lieu d’inventer un succès zéro. Préflight réel suivant accepte ShieldTestUser. Trente-trois tests ciblés passent avec quatre fixtures négatives, typage backend et ESLint passent.

Deuxième recette loopback exit 1 : bounded six reçus/quatre rapports ; redirect six reçus/six succès incorrects ; HTTP 503 six reçus/quatre échecs ; timeout quatre reçus/deux succès incorrects (timeout configuré absent du locustfile). Arrêt manuel passe, deux reçus mais zéro compteurs finalisés : aucune preuve de complétude des mesures d’arrêt. Les erreurs de réception/succès/timeout sont conservées, pas transformées en conformité. Corrections restantes : statistiques finales natives, distinction des tentatives/issues finalisées, classification 2xx et timeout effectif, puis recette étendue.

Sept artefacts des deux tentatives, préflights et reçu sont archivés avec SHA256-attempts01-02.json revérifié dans 2026-10-14-locust-real privé. Sources Locust désormais postérieures au gate/snapshot source-10 ; ce candidat n’est pas présenté comme une release complète conforme. Nouveau gate après les corrections, aucune promotion du contrôle ou production.

## R09 — Locust finalisé, timeout et pacing partagé

Le chemin réel lit désormais un instantané JSON écrit à events.quitting après arrêt explicite des utilisateurs, à partir des statistiques natives finales, pas du CSV périodique. Compteurs started/finalized/unfinalized conservés ; absence ou incohérence du snapshot est une erreur. Les tentatives sans issue ne reçoivent aucun statut HTTP. Le débit utilise la fenêtre monotone complète du driver. Méthode latencyMethod=native-rounded-response-times explicitée dans HTML/CSV et types frontend ; quantiles natifs sur buckets arrondis, pas percentiles exacts.

Timeout explicite par requête, succès limité aux 2xx, redirects désactivés, proxy environnement désactivé côté client. Pacer monotone partagé par tous les utilisateurs et étapes, intervalle entier réservé avant première émission, sans rattrapage de retard ; deadline propre et stop-timeout=0. Les pauses de flow ne peuvent augmenter les budgets. Après la recette, forwarding des headers par étape corrigé conformément au contrat RequestStep (fusion au-dessus des headers campagne) ; cette combinaison spécifique n’est pas encore testée sur cible réelle, les GET à headers inchangés de la recette restent couverts.

Recette extended 03 : bounded/302/503/timeout/flow/fractional passent, phases/distribution unsupported ; stop échoue car aucune émission n’a encore eu lieu à 1,2 s. Le harness exige désormais l’arrêt 150 ms après le premier reçu, avec fallback de démarrage 2,5 s dans le budget inchangé 3 s, et assert d’une requête active. Cela exerce un vrai arrêt en vol, sans augmenter caps ou délais de terminaison. Les artefacts de l’échec sont préservés.

Recette 04 exit 0, **sept cas pris en charge passés** : bounded cinq tentatives/reçus, quatre issues finalisées ; 302 cinq/cinq/cinq, zéro succès ; 503 cinq/cinq/quatre ; timeout cinq/cinq/trois, zéro succès ; stop une/une/zéro, requête active lors de l’arrêt ; flow deux/deux/deux ; fractionnaire deux/deux/deux. Toutes les issues non finalisées restent inconnues. Phases et distribution explicitement unsupported/not-validated. Preuve macOS/Python 3.12.14/Locust 2.46.7, pas parité Linux ou conformité de tous les moteurs.

Cinquante-et-un tests ciblés passent, typage backend/frontend et ESLint passent. Quatre nouveaux artefacts 03/04 archivés avec SHA256-attempts03-04.json revérifié, manifestes précédents conservés. Sources postérieures à source-10 ; nouveau gate requis après les changements. Le cas stop commun modifié doit aussi être réexécuté pour builtin/k6/vegeta avant une comparaison homogène. Aucun déploiement ou campagne produit.

## R09 — Corpus commun et débit fractionnaire builtin

Réexécution du harness étendu avec arrêt en vol pour builtin/k6/Vegeta, chacun sur sa cible loopback dédiée. k6 v2.3.0 : neuf cas passés. Vegeta v12.13.0 : huit cas passés, flow explicitement unsupported. Builtin initialement en échec à 0,5 RPS : cinq reçus en cinq secondes, espacement proche d’une seconde ; un compteur entier comparé à 0,5 autorisait une requête par fenêtre. Artefacts de l’échec préservés.

Builtin réserve désormais des intervalles partagés pour les caps non entières sans arrondir le débit vers le haut. Budget, phases, pauses et throttling utilisent performance.now ; timestamps publics restent ISO wall-clock. Attentes bornées par le temps restant, vérification de deadline juste avant I/O, RPS calculé sur la durée monotone. Validation des nombres non finis et de la concurrence non entière ajoutée. Les fenêtres entières conservent leur comportement de comptage.

Cinquante tests ciblés passent, dont six entrées numériques invalides et une vraie cible loopback lors d’un recul simulé de Date.now : le run termine avant le timer de secours, sur son budget monotone. Un test de flow Locust attendait encore l’ancien constant_pacing ; il est actualisé au contrat de pacing global, pas supprimé. Typage backend, ESLint et Prettier passent.

Nouvelle recette builtin exit 0 : neuf cas étendus passés, sans changer les caps du harness. Neuf artefacts initiaux et après correction archivés avec SHA256-manifest.json revérifié dans 2026-10-14-common-engine-corpus privé. Ces validations restent macOS ; elles ne prouvent pas toute la corrélation, la parité Linux ou la conformité des moteurs JVM encore absents. Sources postérieures à source-10 : nouveau gate nécessaire après corrections.

## R09 — Prérequis JVM officiels vérifiés

Aucun JDK local trouvé. Documentation officielle : JMeter 5.6.3 exige Java 8+ et recommande Java 17+ ; Gatling 3.16.0 supporte les JDK LTS 64-bit 11–25. Le bundle Gatling récent est basé Maven et Java, l’ancien bundle Scala/bin/gatling.sh n’est plus l’interface recommandée : adaptation requise, sans présenter un ancien binaire comme compatible.

API Adoptium initialement HTTP 403 ; métadonnées du dépôt officiel GitHub temurin17-binaries obtenues. Archive Temurin 17.0.20.1+1 aarch64 macOS : **185 851 019 octets**, SHA-256 **196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8**, comparé au checksum officiel avant extraction filtrée data. java -version confirme OpenJDK 17.0.20.1 / Temurin 17.0.20.1+1. Runtime et reçu privés sous ddostester-tools/temurin-17.0.20.1-macos-arm64 ; JAVA_HOME global inchangé. Aucun moteur JVM ou demo externe lancé.

Sources : [JMeter installation](https://jmeter.apache.org/usermanual/get-started.html), [JMeter téléchargements](https://jmeter.apache.org/download_jmeter.cgi), [Gatling installation](https://docs.gatling.io/reference/deploy/install-local/), [migration Gatling](https://docs.gatling.io/release-notes/gatling/upgrading/3.10-to-3.11/).

## R09 — JMeter réel et premières corrections

Apache JMeter 5.6.3 installé privément après contrôle SHA-512 et vérification cryptographique de la signature détachée avec la clé des KEYS officiels Apache. Archive **87 414 762 octets**, signer fingerprint **C4923F9ABFB2F1A06F08E88BAC214CAA0612B399**, commande de version exit 0 sous JDK privé 17.0.20.1. GnuPG absent ; PGPy 0.6.0 dans un venv privé sert de vérificateur. Son contrôle ne couvre pas self-signatures, révocation et disabled flags des clés : portée limitée consignée dans verification-scope.json, aucune certification indépendante du trust de clé revendiquée.

Recette 01 loopback exit 1 : quatre cas émettent après la borne du budget ; 302 traité comme succès et timeout non configuré dans le JMX. Arrêt en vol passe. Commande de version crée aussi un jmeter.log dans le cwd ; disponibilité désormais appelée avec un log explicitement dans un répertoire temporaire privé. Les logs existants ne sont pas supprimés sans preuve de propriété.

Corrections : connect/response timeouts explicites, assertion native 2xx-only, durée de groupe recalculée depuis la deadline transmise par le driver, absence de mesures/colonnes invalides refusée, pseudo-buckets de codes non HTTP supprimés. Supervisor de processus borné à la durée configurée. Cinquante-et-un tests ciblés passent, typage backend, ESLint et Prettier passent.

Recette 02 extended exit 1 : bounded/302/503 passent avec trois reçus chacun, aucun succès 302 ; émission après budget corrigée dans ces cas. Timeout garde un écart reçus/rapports, arrêt passe avec mesure finale indisponible explicite, flow n’émet rien, pacing fractionnaire ne respecte pas encore les intervalles attendus. Phases/distribution restent unsupported/not-validated. Ces cas ne sont pas requalifiés en conformité ; diagnostics natifs et corrections supplémentaires requis.

Six artefacts des deux tentatives, installation et portée de vérification archivés avec SHA256-attempts01-02.json revérifié dans 2026-10-14-jmeter-real privé. Aucun déploiement, campagne produit ou modification de comptes. Sources postérieures au gate/source-10 : nouveau gate requis après stabilisation.

## R09 — JMeter pacing, pauses et issues incomplètes

Source officielle ConstantThroughputTimer rel/v5.6.3 examinée : delay() autorise le premier sample sans délai pour chaque thread, même lorsque le mode de calcul utilise un état partagé. Cette initialisation explique le burst à 0,5 RPS ; changer seulement calcMode ne suffit pas.

Pacing désormais partagé via verrou et System.nanoTime dans un JSR223Timer placé sous chaque HTTPSamplerProxy natif. Les pauses ne dépensent pas de slot HTTP et deviennent un TestAction placé après le sampler, au lieu d’un ConstantTimer exécuté avant celui-ci. Deadline convertie en budget monotone à l’initialisation ; arrêt explicite du thread avant I/O à expiration. Inspection du code JSR223Timer et JMeterThread confirme que les erreurs de script peuvent être absorbées et qu’un thread arrêté ne lance pas le sampler après les timers : la garde ferme donc le thread, pas seulement une exception.

Marqueur privé des tentatives commencées à chaque slot ; JTL conserve les issues finalisées. Le résultat publie finalizedRequests/unfinalizedRequests sans statut inventé pour les issues absentes. RPS corrigé sur les tentatives et la durée monotone complète du driver. Aucun sampler HTTP n’est remplacé par un client de substitution. Les tests qui attendaient l’ancien ConstantThroughputTimer sont actualisés au contrat de pacing partagé et pause après requête ; cinquante-et-un tests ciblés, typage backend et ESLint passent.

Recettes 03 puis 04 extended exit 0 : sept cas pris en charge passent ; phases/distribution explicitement unsupported. Recette 04 : bounded trois reçus/tentatives, deux issues finalisées ; 302 trois/trois/trois, zéro succès ; 503 trois/trois/deux ; timeout deux/deux/une ; flow deux/deux/une ; fractionnaire deux/deux/deux. Arrêt en vol observé avec un reçu et émission stoppée ; JTL final indisponible est une erreur explicite, pas un résultat zéro. Cela valide la borne d’arrêt, pas la complétude de son rapport. Le flow court ne garantit pas que toutes les étapes ont été exercées.

Quatre artefacts 03/04 archivés avec SHA256-attempts03-04.json revérifié, manifestes précédents conservés. Validation macOS/JDK 17/JMeter 5.6.3 uniquement ; parité Linux, headers/body sur cible réelle et collecte complète d’un arrêt interrompu restent ouverts. Nouveau gate complet requis après les changements, aucun déploiement ou campagne produit.

## R08/R09 — Rapport JMeter interrompu sans fausse latence zéro

Le driver conserve désormais le marqueur de tentatives lorsque JMeter n’a pas encore écrit de ligne finale JTL. Reconstruction autorisée seulement avec un compteur de tentatives positif et valide ; absence de preuve de tentative reste une erreur. Aucun succès/statut HTTP n’est inventé. latencySampleCount=0 rend les valeurs numériques historiques de compatibilité non observées : HTML, CSV et RunDetails affichent unknown/vide au lieu de zéro ms. Le CSV expose aussi le nombre d’échantillons. Locust publie son compte natif de latences non nulles ; k6 utilise les issues finalisées lorsqu’elles sont connues, sans relabeler les anciens résultats.

Recette JMeter 05 extended exit 0, sept cas pris en charge passés : arrêt en vol avec une tentative/reçu, finalized=0, unfinalized=1, latencySampleCount=0, statusCounts vide et erreur null. Le rapport conserve donc le début d’activité et son incertitude au lieu de disparaître. Deux artefacts 05 archivés avec SHA256-attempt05.json revérifié ; précédents manifestes préservés.

Vingt-cinq tests backend et dix-sept frontend ciblés passent pour parser/export/UI ; puis soixante-neuf tests backend agents/k6/rapports passent avec les champs communs, typage backend/frontend et ESLint passent. Preuve limitée aux composants et corpus indiqués ; pas de gate complet/CI Node 22 ou parité Linux encore acquis sur ces sources. Locust est réexécuté pour vérifier le nouveau champ natif. Aucun déploiement.

Locust 05 termine ensuite exit 0 : sept cas pris en charge passés, arrêt avec latencySampleCount=0 explicite. Deux artefacts supplémentaires archivés avec SHA256-attempt05.json revérifié dans le corpus privé Locust.

### 2026-10-14 — Gatling : préparation hors ligne et absence de mesures

Le bundle officiel Gatling 3.16.0, installé dans le répertoire privé des outils, contient Maven 3.9.16 et son dépôt de dépendances. Avec le JDK privé Temurin 17.0.20.1, `sh ./mvnw --offline --version` puis `sh ./mvnw --offline --batch-mode test-compile` terminent avec le code 0. Cette compilation ne lance aucune simulation et ne valide pas encore le générateur Ddostester ni son interface de lancement moderne.

Le parseur Gatling refuse désormais les journaux sans requête finalisée et les lignes REQUEST sans deux horodatages exploitables ou sans statut OK/KO. Il renseigne le nombre de mesures de latence. Les huit tests de `backend/test/agents2.test.ts` passent. Le compteur des tentatives interrompues, les statuts HTTP et la recette réelle restent à implémenter/valider ; aucun succès global de conformité Gatling n’est revendiqué.

### 2026-10-14 — Compilation du Java produit par Ddostester

La compilation hors ligne des simulations générées confirme un échec pour maxRps=0,5 : le SDK Gatling 3.16.0 expose jumpToRps(int), donc le Java actuel tente une conversion double vers int interdite. Le fichier de reproduction est conservé hors dépôt sous ShieldTestFractional.failed.java.txt dans le bundle privé. Le support fractionnaire reste à corriger, sans arrondi qui augmenterait le débit demandé.

Le générateur transmet désormais timeoutMs (10 secondes par défaut), impose un statut compris entre 200 et 299, transmet les corps PUT/PATCH et fusionne les en-têtes propres à une étape avec ceux du scénario. Une simulation PUT avec corps et timeout de 300 ms compile contre le SDK natif, via Maven offline test-compile (code 0). Aucun envoi HTTP ni lancement de simulation dans cette vérification. La modernisation du lanceur, le pacing fractionnaire et les compteurs des requêtes interrompues restent ouverts.

### 2026-10-14 — Débit fractionnaire Gatling natif

Le throttle entier est remplacé par une porte partagée synchronisée et monotone, placée avant chaque requête native, y compris chaque étape de flow. Les utilisateurs en attente utilisent les pauses asynchrones de Gatling ; un retard ne crée pas de crédits de rattrapage. La durée maximale native reste appliquée. Les simulations à 2 et à 0,5 requête/s compilent hors ligne contre Gatling 3.16.0.

Recette privée `2026-10-14-gatling-gate/attempt01` : cible HTTP loopback créée par la recette, deux utilisateurs, cinq secondes, 0,5 requête/s, timeout 500 ms. Lancement explicite de ShieldTestFractional via Maven offline gatling:test ; aucune sélection de la démonstration externe. Sortie 0, trois requêtes reçues, trois succès natifs, intervalles à la cible 2000,78 et 1997,98 ms (jitter de transport/ordonnancement ; tolérance de recette 10 ms). Deux preuves privées et manifeste SHA-256 conservés. Les 27 tests agents2/flow passent. Le lanceur de l’application utilise encore l’ancienne interface : cette recette ne prouve pas la conformité du chemin applicatif complet.

### 2026-10-14 — Lanceur Maven applicatif : intégration partielle

GATLING_HOME sélectionne désormais le bundle Maven 3.16.0. Le projet Java est créé dans un répertoire temporaire, compilé hors ligne, puis la classe ShieldTestSimulation est sélectionnée explicitement. Le superviseur conserve annulation et arrêt du groupe de processus ; compilation limitée à 60 secondes, exécution à durée + 15 secondes de démarrage/arrêt JVM. Le dossier de résultats est configuré dans le plugin Maven, car resultsFolder ne possède pas de propriété utilisateur gatling.resultsFolder dans plugin.xml 4.21.12.

La première recette applicative sans authorized=true est refusée avant toute requête (attempt02 conservé). La recette explicitement autorisée sur son propre listener loopback envoie trois requêtes à 0,5 RPS, mais échoue honnêtement à produire le rapport (attempt03). Inspection du fichier natif : simulation.log 3.16.0 est binaire, donc le lecteur tabulé ancien est incompatible. Le lecteur binaire reste à implémenter ; le mode Maven ne doit pas encore être considéré opérationnel de bout en bout. Aucune conformité globale Gatling revendiquée.

### 2026-10-14 — Lecture binaire et premier rapport Gatling applicatif

Le lecteur binaire est dérivé des classes natives vérifiées du bundle 3.16.0 : RunMessageSerializer, ResponseMessageSerializer, UserMessageSerializer, GroupMessageSerializer, ErrorMessageSerializer et BufferedFileChannelWriter. Il vérifie version, limites de lecture, références de cache, types de records, booléens et chronologie des réponses. Les mesures représentent uniquement les réponses finalisées ; aucun statut HTTP ni tentative interrompue n’est inventé. Budget commun processStreamBytes contrôlé avant lecture et au décodage. Une fixture issue de la recette native confirme trois réponses ; les fichiers tronqués, types inconnus et références absentes sont refusés.

Recette applicative attempt04 : deux utilisateurs, cinq secondes, 0,5 RPS, cible loopback dédiée explicitement autorisée. Le lanceur compile puis exécute hors ligne et produit un rapport : trois reçues, trois finalisées, trois succès, trois échantillons de latence (6–8 ms). Espacements à la cible 2004,60 et 2004,17 ms. Preuve privée et SHA-256 conservés. actualRps=0,32 utilise encore l’enveloppe incluant le démarrage Maven/JVM, donc ne représente pas exactement la fenêtre active de charge. Les compteurs pré-I/O, les arrêts en vol, les codes HTTP, le débit sur fenêtre active et la recette complète restent ouverts.

### 2026-10-14 — Gatling : tentatives interrompues et fenêtre monotone

La simulation écrit atomiquement un compteur avant chaque action HTTP native et un snapshot final lors de l’arrêt JVM. La durée est calculée par System.nanoTime depuis la première tentative, en excluant compilation et démarrage JVM. Le rapport conserve finalizedRequests, unfinalizedRequests et latencySampleCount ; sans snapshot final valide, il refuse de prétendre connaître ces mesures. Le délai entre permis est plafonné au-delà de la durée du scénario pour éviter un débordement long avec des débits extrêmement petits, sans augmenter le nombre de permis dans cette fenêtre.

Recette privée attempt05 : débit fractionnaire, trois reçues/finalisées et zéro inconnue, actualRps 0,596 sur environ 5,03 secondes (discrétisation trois départs pour une demande 0,5 RPS). Intervalles reçus 1956,61 et 2002,81 ms : le premier transport/démarrage de l’action HTTP introduit un écart de 43 ms, donc cette recette ne prouve pas un espacement strict à la cible avec la tolérance 10 ms précédente. Arrêt en vol déclenché 150 ms après la première réception : une tentative, une reçue, zéro finalisée, une inconnue, zéro échantillon de latence, aucun statut inventé. Snapshot final conservé malgré SIGTERM. Les compteurs HTTP et le corpus complet restent ouverts. Preuve et SHA-256 privés conservés.

### 2026-10-14 — Codes HTTP natifs et corpus Gatling en échec

Les codes HTTP sont capturés via status().saveAs dans le moteur natif, avec suppression de la valeur précédente avant chaque tentative. Le snapshot final conserve les classes observées. Ces observations peuvent survivre à un signal alors que le journal natif de latence est encore bufferisé : elles sont bornées par le nombre de tentatives, sans convertir une réponse observée en mesure de latence inventée. Une issue non finalisée demeure explicitement inconnue même si son code HTTP a été capturé.

Corpus commun extended attempt06, conservé avec SHA-256 : aucun des sept cas pris en charge ne passe entièrement. Redirection : six reçus et six codes 3xx, aucun suivi. Erreur : six reçus, cinq mesures natives et cinq codes 5xx. Le watchdog de dix secondes et le fallback stop de 2,5 secondes interrompent la compilation/le démarrage JVM ou la vidange des mesures. Les assertions de durée du corpus mesurent actuellement tout le démarrage depuis agent.run, tandis que Gatling applique durationSec à sa phase native de charge ; cet écart de contrat doit être traité explicitement, sans prétendre que la recette est verte. Les phases/distributions restent unsupported.

La configuration GATLING_HOME/JAVA_HOME figure dans .env.example. Le lien inexistant offensive-integration.md est remplacé par la recette existante, et engine-strategy.md précise que ses chiffres d’installation/usage de septembre sont historiques.

### 2026-10-14 — En-têtes JMeter, CSV strict et gate local 11

JMeter fusionne désormais les en-têtes globaux et ceux de chaque étape, sans propager une surcharge à la suivante. Recette réelle privée headers-body-attempt01 : listener loopback dédié, six secondes, deux RPS, un utilisateur, GET puis POST. Neuf requêtes reçues ; la cible confirme X-Mode=step sur GET, X-Mode=global sur POST, X-Keep=a&b conservé et corps JSON intact. Preuve et manifeste SHA-256 conservés.

Le lecteur JTL gère les champs CSV cités, virgules, nouvelles lignes et guillemets doublés. Les lignes de longueur incorrecte, succès invalides, latences absentes/négatives/non entières et citations tronquées sont refusés explicitement. Les tests ciblés passent.

Gate local 11 : npm run verify termine avec code 0 en 122,81 secondes ; lint/Prettier, TypeScript backend/frontend, 1112 tests backend (26 conditionnels ignorés), 409 tests frontend et builds passent. Logs/résultat privés et manifeste SHA-256 conservés. Cette preuve ne remplace pas le gate PostgreSQL explicite, les recettes navigateur ni les validations Linux de la version actuelle. HEAD reste d98db08ecb520b4021df645e7aded44fe38ad939 ; .DS_Store et le travail local préexistant sont préservés.

Inspection du contrat Gatling : la sonde commence en parallèle de agent.run dans campaigns/runner.ts, tandis que la compilation et le démarrage JVM sont actuellement internes à cet appel. Modifier seulement les tolérances de la recette masquerait ce décalage de mesure. Une séparation explicite de préparation/charge ou un autre alignement vérifiable reste nécessaire ; le corpus Gatling attempt06 reste en échec et n’est pas requalifié en succès.

### 2026-10-14 — Préparation native Gatling et fenêtre de mesure alignée

AttackAgent possède un contrat optionnel prepare : une ressource prête sans trafic cible, lancement unique, puis dispose obligatoire. Le runner prépare après calibration, rafraîchit la baseline, puis arme minuteur et sonde de charge. Dispose s’exécute aussi si la baseline est annulée ou si le lancement échoue. Deux tests de cycle de vie confirment que 1,1 seconde de préparation ne consomme pas une charge de 1 seconde et qu’une annulation après préparation ne lance aucune charge. Les 14 tests runner passent ; les 60 tests agents/flow/binaire passent, TypeScript et ESLint ciblé passent.

Gatling compile hors ligne dans un projet temporaire puis démarre un nombre fixe d’utilisateurs natifs (concurrence demandée). Ils signalent leur disponibilité depuis le scénario et attendent le départ par pauses asynchrones, sans HTTP. Préparation bornée à 60 secondes, arrêt manuel actif, copie indépendante de la configuration, validation de destination avant préparation et au départ. La porte de débit est partagée et monotone ; les pauses de réflexion ne dépassent pas la fenêtre restante. L’ancienne tentative de hook avant démarrage n’est pas utilisée : attempt07 conserve l’échec de signature Java, attempt08 révèle environ une seconde d’initialisation restant après le hook. Attempt09 confirme zéro requête avant départ, première réception 25–30 ms après, six finalisées dans le cas normal.

Corpus commun extended attempt10 : sept cas pris en charge passent, zéro reçu pendant chaque préparation (6,3–8,6 secondes). Bornes inchangées pour la phase de charge : six reçus/finalisés pour bounded, redirection 302 et erreur 503 ; six timeouts finalisés sans statut HTTP inventé ; trois reçus/finalisés pour flow et 0,5 RPS ; arrêt en vol exercé. Durées de charge ordinaires 3,1–3,65 secondes, cas fractionnaire 5,09 secondes. Phases et distribution restent unsupported ; cette recette ne valide ni corrélation, ni parcours complet de trois étapes, ni parité Linux. Les temps de préparation sont enregistrés séparément et leur absence de trafic est une assertion supplémentaire.

Intégration réelle executeCampaign sur cible loopback dédiée, charge /load et sonde /probe distinctes : première tentative conserve six inconnues après arrêt brutal à la durée. L’arrêt contrôlé écrit maintenant le signal stop, interdit les nouveaux départs, accorde au plus processGraceMs (1 seconde) à la finalisation native, puis force le groupe si nécessaire. Deuxième tentative : six requêtes reçues, six finalisées, zéro inconnue, trois échantillons de baseline rafraîchie et une observation de sonde ; sept requêtes légitimes /probe au total incluant les deux captures de baseline. Ce cas court ne valide pas la qualité WRS ni le parcours API/auth/PG.

Recette d’annulation supplémentaire : réponse de 600 ms, une reçue/finalisée, aucun départ après stop, règlement 555 ms après stop ; cible de 15 secondes avec timeout client 10 secondes, une reçue/non finalisée, zéro latence inventée, règlement forcé 1429 ms après stop. Sept preuves et leur manifeste SHA-256 privés conservés.

### 2026-10-14 — Gate local 12 après intégration de préparation

La vérification complète npm run verify termine avec code 0 en 123,07 secondes : lint/Prettier, TypeScript backend/frontend, 1114 tests backend (26 conditionnels ignorés), 409 tests frontend et builds passent. Les preuves privées verify.log/result.json et leur manifeste SHA-256 sont vérifiés. Ce gate inclut le contrat de préparation, sa gestion de baseline/minuteur/libération, le signal de départ depuis les utilisateurs Gatling démarrés et l’arrêt contrôlé puis forcé. Les gates PostgreSQL, navigateur et Linux de cette version restent distincts et non revendiqués par ce résultat local.

### 2026-10-14 — Calibration fractionnaire et PostgreSQL reproductible

Audit confirmé : calibratedRate et le runner relevaient une demande de 0,5 RPS à 1 RPS ; scaleScenario imposait aussi un plancher à 1 sur chaque phase. La calibration conserve maintenant le débit demandé exact, garde 0,5 sans mesure exploitable, ou réduit une livraison de 0,2 à 0,19 RPS. Les phases sont réduites proportionnellement sans plancher artificiel. Les paramètres non finis sont rejetés ou qualifiés comme mesure absente. Le commentaire promettant une mesure toujours valide est corrigé : la confiance dépend toujours des observations et de leur qualité.

Quinze tests calibration passent. Quatre tests runner sélectionnés passent, dont le parcours complet de configuration 0,5 vers 0,19. Le premier passage avait détecté 113,99999999999999 au lieu de 114 après multiplication du facteur ; le débit plat est maintenant repris directement du résultat de calibration, sans modifier les attentes du test entier.

Nouveau script local-postgres-gate.mjs : nouveau dossier privé hors dépôt (y compris parents symlinks), contexte Docker Unix local conservé, image PostgreSQL 16 déjà en cache et référencée par ID, conteneur temporaire non-root/lecture seule/0,5 CPU/512 MiB et données tmpfs. Aucun URL de base applicative accepté, aucun téléchargement. Les suites PostgreSQL obligatoires et recovery-check sont lancés puis les identités et absences des ressources sont vérifiées. Le second passage ajoute un bridge réservé au gate et conserve les erreurs initiales et de nettoyage ensemble.

Gate PostgreSQL 13 puis 14 : cinq fichiers, 37 tests PostgreSQL réussis, restauration chiffrée réussie, conteneurs supprimés ; gate14 réseau supprimé avec absence vérifiée. Credentials temporaires supprimés. Neuf preuves et deux manifestes SHA-256 privés vérifiés. Exécution Node 26.8.1, image locale ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d ; cette preuve ne revendique pas la parité Node 22/CI. Aucune base de production modifiée.

### 2026-10-14 — Gate local 13

Après correction de la calibration fractionnaire et ajout du gate PostgreSQL reproductible, npm run verify termine avec code 0 en 127,41 secondes : lint/Prettier, TypeScript backend/frontend, 1116 tests backend (26 conditionnels ignorés), 409 tests frontend et builds passent. Les 37 tests PostgreSQL et recovery-check de cette version ont été validés séparément dans le gate PostgreSQL 14. Les preuves privées et manifestes sont conservés. Les validations navigateur et Linux de cette version restent ouvertes ; aucun déploiement de production n’est revendiqué.

### 2026-10-14 — Corpus navigateur et rétablissement des rapports

Configuration Playwright actualisée : administrateur de fixture unique abdelha@wedos (mot de passe de test sans rapport avec la production), secret aléatoire de 48 octets, base en mémoire explicite, scheduler/flotte/notifications externes désactivés. Une cible HTTP loopback dédiée sur 8100 est séparée de l’API 8099, et les ressources sont arrêtées par le serveur de fixture. Le navigateur demandé par Playwright (révision 1248) est absent ; le Chromium déjà installé est sélectionné explicitement : Chrome for Testing 153.0.8010.12, révision 1243. Ce résultat ne revendique pas la parité du navigateur CI.

Vingt scénarios de profils, connexion/déconnexion, gestion des comptes, limites, thèmes, recon et préparation passent. Les vieux sélecteurs de heading/target sont corrigés ; le test de preset exige maintenant le bouton réel Use this preset. Le raccourci Command Center doit effectivement naviguer vers Run Theater, sans succès silencieux si le lien historique a disparu.

Premier corpus complet : 67 réussites, 16 échecs, avec le limiteur de connexion 20/IP/minute déclenché par les réauthentifications artificielles. La protection applicative n’est pas modifiée. Les fixtures réutilisent des sessions réellement signées, revalidées via auth/me pour email et rôle avant restauration ; elles sont stockées temporairement hors dépôt en 0600 dans un dossier 0700 et supprimées par un teardown à identité vérifiée. Les tests explicites de connexion restent frais. Deuxième corpus : 79 réussites, quatre échecs.

Deux échecs confirment une régression réelle : reports n’avait plus de route et renvoyait à l’accueil. Nouvel écran Results authentifié, accessible dans la navigation : historique conservé, exports compliance/CSV, liens de rapports, choix avant/après empêchant l’auto-comparaison, et partage du seul token de lecture émis par le serveur. Aucun token de session d’écriture dans les liens d’export. Le partage est absent en single ; les erreurs de lecture ne sont pas transformées en historique vide. Quatre tests frontend significatifs passent et les quatre parcours navigateur navigation/rapports passent avec deux exécutions réelles bornées sur la cible dédiée. Les deux autres échecs étaient des sélecteurs de chips retirées ; les cinq parcours templates passent après utilisation du champ cible actuel.

Dernier passage complet attempt03 : 83 réussites, zéro échec, zéro scénario ignoré, zéro flaky. Rapports JSON, sorties et premiers échecs conservés dans le dossier privé browser-01 avec manifeste SHA-256. Scope : corpus existant en team/mémoire sur Mac Node 26 ; single/PostgreSQL, mobiles, clavier/contraste, expiration et reconnexion SSE restent à valider spécifiquement. Aucune base ni campagne de production utilisée.

### 2026-10-14 — Gate local 14 après rétablissement Results

La vérification complète termine avec code 0 en 133,77 secondes : lint/Prettier, TypeScript backend/frontend, 1116 tests backend (26 conditionnels ignorés), 413 tests frontend et builds passent. Ce gate complète le corpus navigateur local de 83 réussites ; les validations PostgreSQL, single-mode UI et Linux restent des preuves distinctes. Logs/résultat et manifeste SHA-256 privés conservés, git diff --check sans erreur et .DS_Store préexistant préservé.

### 2026-10-14 — Mobile, clavier, contraste ciblé et session expirée

Six nouveaux contrôles navigateur passent sur la fixture locale team/mémoire : pages principales de l’owner à 320 et 390 px sans débordement horizontal du document ; connexion par Tab/Entrée puis accès Campaigns avec focus visible ; contraste calculé des liens de navigation en thèmes clair et sombre ; rejet réel d’un JWT signé mais expiré, retour à Sign in et suppression du token local. Le secret aléatoire de la seule fixture est fourni aux workers par globalSetup, puis retiré par le teardown. Aucun changement de durée de session ni de validation JWT dans l’application.

Le calcul de contraste compose les couleurs CSS des fonds solides, tient compte de l’alpha et des couleurs color(srgb), attend les transitions de thème et utilise les luminances relatives. Le seuil normal 4,5:1 est vérifié dans la documentation officielle W3C : https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html. Après élimination de la mesure transitoire, le lien actif sombre était à 4,250566:1 ; ses textes utilisent désormais --text, tandis que le fond et le rail bleu restent présents. Les liens mesurés passent dans les deux thèmes. Ce contrôle partiel ne valide pas gradients, graphiques, états de survol ni toute la conformité WCAG.

Le rapport JSON, les couleurs calculées jointes aux tests, la sortie et le manifeste SHA-256 sont conservés dans accessibility-01. Reconnexion SSE et navigateur single/PostgreSQL restent ouverts, ainsi que la parité du navigateur CI.

### 2026-10-14 — Gate local 15

Après correction du contraste du lien actif, npm run verify termine avec code 0 en 132,50 secondes : lint/Prettier, TypeScript, 1116 tests backend (26 conditionnels ignorés), 413 tests frontend et builds passent. Les six contrôles navigateur mobiles/clavier/contraste/expiration sont conservés séparément ; cette preuve ne revendique pas une certification complète d’accessibilité, la reconnexion SSE ni la recette navigateur single/PostgreSQL. Logs et manifeste SHA-256 privés conservés.

### 2026-10-14 — Reconnexion du suivi SSE

RunTheater et LiveProgress laissent désormais EventSource réessayer après une erreur de transport ; fermeture conservée à la fin du run et au démontage. Un avertissement reste visible avec les dernières valeurs reçues tant que le flux est interrompu. Le test ciblé vérifie que le gestionnaire d’erreur ne ferme pas la connexion : 13 tests du fichier Command Center passent.

Une coupure réelle des seules réponses SSE est provoquée par le proxy de la fixture E2E, avec une commande authentifiée réservée aux tests. La simple émulation offline du navigateur ne déclenchait pas cette panne et n’est pas retenue comme preuve. Le navigateur constate l’avertissement, une nouvelle réponse SSE réussie, sa disparition et la fin de la campagne ; une seule requête POST execute et un seul identifiant de flux sont vérifiés. Le contrôle et la cible restent exclusivement sur loopback, campagne de 12 secondes à 2 RPS, concurrence 2. Le test passe en 23,29 secondes ; JSON, compteurs joints et manifeste SHA-256 privés dans 2026-10-14-sse-01. Ce contrôle ne prouve pas une reprise après redémarrage du serveur ni après expiration de session. Le gate complet 16 est lancé séparément ; son résultat reste à constater.

### 2026-10-14 — Incrément Fleet Management livré, build 453

Nouvelle destination /fleet et lien Fleet : inventaire IoT avec enregistrement, édition, suppression confirmée, groupes, profils sensor/camera/gateway/generic, IP privées RFC1918, notes et recherche. Les écritures sont réservées aux administrateurs, la lecture aux profils autorisés. Unicité des identités/IP, plafond de 1000 appareils et audit atomique ; migration PostgreSQL additive fleet_devices_v1. Les profils et IP constituent des métadonnées d'inventaire, pas une preuve de connexion ni une commande de provisioning. L'observation du coordinateur reste séparée et indique explicitement quand il n'est pas configuré.

Cinq tests API passent : CRUD/auteur d'audit, adresses et champs refusés, concurrence/doublons, rollback sur panne d'audit et droits viewer. Parcours navigateur réel CRUD/rechargement/recherche passé en 6,6 s. Gate PostgreSQL éphémère : 39 tests et restauration chiffrée passent, ressources supprimées avec absence vérifiée. Gate complet local : 1122 backend / 27 conditionnels ignorés, 413 frontend, lint/types/builds réussis. Sur Linux Node 22 : 16 tests ciblés passent, 11 PostgreSQL conditionnels ignorés (preuve réelle PostgreSQL séparée) ; compilation native réussie.

Snapshot source13 vérifié : 625 fichiers, archive e0ca0b2de3c4ff863ab2d9b03c2df2397cbe980b2c2e973687bb1c74232627ca. Release séparée /home/shieldtest/ddostester-releases/fleet-e0ca0b2de3c4, build 453. Promotion terminée, service actif, API/readiness et tous assets vérifiés avec manifeste ; /fleet répond 200 et API inventaire anonyme 401. Mode single, PostgreSQL, 11 comptes et seul admin abdelha@wedos ; digest des mots de passe/profils/statuts/versions de session identique avant/après. Ancienne release et sauvegarde pré-promotion conservées. Les modifications locales et Git restent préservés. Preuves privées dans fleet-deployed-453. L'incrément suivant reste le raccordement provisioning/heartbeat et les commandes par appareil ; aucune connectivité simulée n'est annoncée comme réelle.

### 2026-10-14 — Flotte de recette déployée sur le VPS lab

À la demande de déploiement de la flotte : trois pods lab-iot-01/02/03 dans ddostester-lab sur 31.31.74.187, IP réelles 10.247.0.69/.68/.70, Node 22.23.3 dans l'image source06 déjà en cache et épinglée. Ces observateurs utilisent le client inventory-heartbeat/v1 de la build 454 et ne génèrent aucun trafic de campagne. Certificats mTLS individuels signés par une CA lab distincte, confiance ajoutée à Caddy en conservant la CA utilisateurs existante ; validation de configuration, reload et requête TLS depuis le VPS lab réussis. Aucun certificat privé de CA ni session utilisateur dans les pods.

Les trois identités sont inscrites transactionnellement dans l'inventaire de production, groupe VPS Lab, avec audit operations:lab-fleet-deploy. Empreinte des comptes préservée, 11 comptes conservés. Pas de collision avec l'inventaire existant. Les clés applicatives sont hachées en base et transférées directement via SSH vers les Secrets individuels ; copies temporaires d'enrôlement supprimées après installation. Les clés privées de transport restent aux emplacements privés du lab et dans les Secrets des agents.

Dry-run serveur des manifests puis création réelle ; le premier parsing du retour kubectl a rencontré plusieurs documents JSON, après création réussie. Le décodeur est corrigé et les ressources sont relues par label sans nouvelle création. Premier wait Ready expiré pendant la projection des Secrets ; les pods restaient vivants et n'ont pas été relancés. Observation suivante : 3/3 Running et Ready, zéro redémarrage, logs de heartbeats acceptés ; nouvelle vérification Ready réussie. Côté application : trois agents online, IP distinctes, lastSeen récent et version inventory-heartbeat/v1. Production toujours build 454.

Les pods n'ont pas de token Kubernetes, sont non-root avec filesystem racine en lecture seule et capacités retirées. Enveloppe par agent : requests 25m/64Mi, limits 100m/128Mi, emptyDir 16Mi. Egress explicitement autorisé vers le contrôle TLS 31.31.74.228:443, avec DNS commun du lab ; aucune autorisation vers la cible. Durée de recette bornée à 24 h, pas de retry automatique. Provisioning depuis l'UI, activité IoT générée, gestion continue de rotation/remplacement et campagnes distribuées restent à raccorder. Le guide Fleet et les scripts d'opération sont dans le dépôt ; preuves publiques d'opération et manifests SHA-256 conservés dans fleet-vps-01, hors dépôt.

### 2026-10-14 — Suspension demandée et reste à faire conservé

Instruction utilisateur : garder le reste à faire en mémoire, arrêter le développement en autonomie et avancer ensemble sur la flotte. Aucun développement autonome à reprendre sans instruction explicite. Le point de reprise Fleet, les limites du déploiement de 24 h et les huit chantiers restants sont enregistrés dans fleet-management.md. La commande d'arrêt avec acquittement était seulement annoncée/examinée, sans implémentation. Les agents déjà déployés ne sont pas supprimés ; aucun renouvellement automatique n'est ajouté.

Reste global R01–R10, en complément de ce point Fleet : organiser les changements en commits/PR et sources de release revues ; consolider la parité CI/Node 22 et les parcours single/PostgreSQL (fixture bloquée par migration des comptes) ; compléter incidents d'exploitation, rétention, rotation et séparation des clés/témoin ; valider la sonde et ses dégradations sur la version finale ; finaliser recette Mac, images et promotion cohérente du laboratoire ; terminer identité/rotation et cycle de vie des agents, IoT distribué, partitions/pertes/reconnexion et budgets ; valider agrégation/comparaisons homogènes et dashboard flotte déployé ; compléter conformité des six moteurs sur Linux, flows et accessibilité ; raccorder Kusa sur son contrat réel puis produire la recette finale et le dossier infrastructure. Ces exigences ne sont pas déclarées terminées par les tests locaux ou le déploiement des observateurs.

Production build 454 ; contrôle du laboratoire source06 ; trois observateurs utilisant le client inventory-heartbeat/v1 de la release 454. Source14 identifié par archive 4a11c80cd3abcb9fb861dd05766ed85f74f85f989e7cf5ba57d21d06e58b6a07. Travaux locaux, index et branche préservés. Vérification des processus locale à la pause : aucun build/Playwright/déploiement de cette tâche actif ; tunnel Grafana préexistant non interrompu. Dernières preuves datées disponibles hors dépôt ; l'état distant devra être revérifié à la reprise.

### Livraison Fleet ciblée — build 455

À la demande de reprise autonome limitée à la flotte, livraison du parcours de
sélection, lancement confirmé, compteurs et arrêt des trois agents déjà provisionnés.
Production vérifiée sur source16 `ec038f70ce7a` ; 11 comptes préservés. Les agents
conservent leurs fiches et utilisent maintenant les IP privées `.71`, `.72`, `.73`.
La cible privée corrige ses permissions de fichiers tout en restant non root et
avec du contenu en lecture seule.

Recette finale : 51 requêtes HTTP 200 sur la mission normale ; 21 sur la mission
arrêtée ; compteurs exacts confirmés à la réception et trois arrêts acquittés.
Deux recettes navigateur ont également lancé et arrêté les agents depuis les
boutons de production. Sonde : 89/90 mesures au premier passage, avec un timeout
initial conservé ; initialisation séparée puis 30/30 HTTP 200 lors du contrôle
suivant. Aucun score WRS ni résultat de capacité n'est déduit de cette recette.

Les tests backend/frontend/PostgreSQL, la restauration, les builds et les contrôles
natifs passent. Les permissions et le client téléchargeable sont aussi corrigés
pour les prochaines images Docker. Les preuves restent hors dépôt, dans
`2026-10-14-fleet-missions-live-01`.

La roadmap générale reste suspendue. Restent pour un prochain incrément convenu :
profils IoT POST, provisioning de pods depuis Fleet, renouvellement automatique
et changement d'IP, intégration aux campagnes/suites et rapports généraux, capacité,
VPS cible externe explicitement identifié, puis interface réseau/Kusa de l'équipe
infrastructure. Cette livraison ne lance pas ces travaux supplémentaires.

### Livraison du premier parcours de campagne Fleet — build 456

Le moteur `fleet` utilise les trois agents enrôlés du groupe VPS Lab, via les mêmes
assignations, baux et budgets que les missions précédentes. Fleet ouvre la
reconnaissance de cible ; la campagne fournit target/probeUrl ; Run Theater affiche
les trois états et l'arrêt habituel de campagne ferme les baux. Les résultats sont
persistés et rejoignent les rapports de campagne existants.

Recette navigateur de production sur `http://46.28.109.92/`, 3 RPS au total et
20 secondes maximum : campagne `5a3a54cb-aa50-43ff-992d-ef667f2d200a`, 50 réponses
2xx et trois SUCCEEDED ; campagne `d7e0e1fe-221a-4444-be1f-e0a1f1296a8c`, arrêt
depuis le Theater, 20 réponses 2xx, une requête annulée et trois STOPPED.
Sonde depuis le VPS applicatif : 4/4 et 2/2. La contention CPU côté agents reste
signalée et le verdict de capacité est inconclusive ; aucun ancien timing de
protection classe C n'est repris comme mesure de ces runs.

Build/source `456 / 7b16410ba980`, API et assets vérifiés, comptes et inventaire
préservés. Tests : 1 130 backend, 416 frontend, 42 PostgreSQL et restauration.
Les agents sont au repos et aucune campagne ne reste RUNNING. L'autonomie s'arrête
à cette livraison, conformément à la demande de rendre la main.
Restent : profils POST, sélection configurable des appareils, refonte des pages,
suites Fleet, connecteur de protection corrélé, optimisation CPU, provisioning,
rotation automatique et raccordement Kusa/infrastructure.

### Livraison des lots 2 et 3 du parcours IoT — build 457

À la demande de terminer les deux lots suivants, les mesures/rapports et les
interfaces sont livrés. Sélection de un à trois appareils persistée dans la
campagne ; même enveloppe partagée, mêmes baux, credentials et règles réseau.
Fleet prépare les agents et montre les affectations et échéances ; le dashboard
résume la flotte ; les campagnes montrent moteur/effectif ; un template Fleet
GET maintient la reconnaissance ; le Theater et les résultats montrent les preuves.
Les anciennes commandes de mission rangées en diagnostics arrêtent aussi le
kill switch de campagne lorsqu'elles ciblent une campagne.

Rapports HTML et JSON : débit, latence, compteurs et ressources par agent, sonde
indépendante corrélée au run, données manquantes explicites, erreurs d'annulation
conservées. Un import administrateur borné et audité ajoute des reçus cible
attestés par l'opérateur, valide origine/trace/fenêtre et empêche un écrasement.
Le journal nginx dédié sur 46.28.109.92 ne capture que les traces Fleet, sans
cookies ou credentials, et n'a changé ni endpoints, ni ports, ni firewall.

Recette réelle : campagne `cc0833d4-7944-4d0f-8602-74f39e3bba25`, deux agents
lab-iot-01/lab-iot-03, 49 réponses 2xx, sonde 4/4 et 49 reçus concordants ; campagne
`de022812-5a17-46e4-959c-972bdb31abb2`, trois STOPPED par le Theater, 19 réponses 2xx,
sonde 2/2 et 19 reçus concordants. Source récepteur commune 31.31.74.187. Les
rapports/export/vues de résultats relus confirment les rapprochements. Aucun score
de capacité n'est certifié ; les réserves CPU et timings estimés sont conservés.

Build/source 457 / 72f8b2a69860 ; API et assets vérifiés, comptes et inventaire
préservés, aucune campagne RUNNING. Validation : 1 135 backend, 418 frontend,
42 PostgreSQL et restauration, typecheck/lint/builds et navigateur réel.
L'autonomie s'arrête après livraison de ces lots. Restent les comportements POST,
suites Fleet, collecte automatique, optimisation CPU, provisioning/rotation et Kusa.

### 14 octobre — simplification des campagnes, build 458

Déploiement explicitement demandé après implémentation. Snapshot source22 : `6a950544bd734726b7563470d10e5d14577ceb5669a7b3eb6ee8d61e4842b7bc`, release `/home/shieldtest/ddostester-releases/campaigns-6a950544bd73`. Tests natifs : 34 backend et 51 frontend, build natif réussi. Sauvegarde PostgreSQL privée avant bascule ; comptes, mots de passe et inventaire préservés. Build457 conservé pour rollback.

API, disponibilité et sommes des fichiers UI vérifiées. Vérification navigateur via mTLS : historique Fleet sans formulaire de lancement, duplication vers un nouveau brouillon, choix Local/Fleet, cible et sonde conservées, inventaire des trois agents et confirmation neuve. Aucun appel API de mutation depuis le navigateur ; aucune campagne lancée. Session de vérification temporaire supprimée après contrôles. Fin du périmètre autorisé, aucune reprise de la roadmap générale.

### 14 octobre — compteur de bots Run Theater, build 459

Demande de compteur dynamique pour les campagnes utilisant Fleet : livrée et publiée, sans changement des agents ni du trafic. Jauge active/affectée, cartes par agent et six catégories d’états, réutilisant le polling de campagne existant à une seconde. Les données indisponibles restent inconnues ; mouvements réduits respectés. Tests locaux 1 135 backend et 423 frontend, natifs 34 backend et 54 frontend, build et version API/UI vérifiés. Recette navigateur en lecture seule sur deux runs historiques, captures ordinateur/mobile examinées. Comptes et inventaire préservés, sauvegarde PostgreSQL effectuée, build458 gardé pour rollback ; session temporaire de recette supprimée. Source24 `2ff61016de6c4f200c13268f0cffba307da053122fdb06b86f7f1a93d5f10242`. Aucune campagne supplémentaire ni reprise de la roadmap générale.

### 14 octobre — entrée des modèles préconfigurés corrigée, build 460

Le retour utilisateur montre une campagne créée depuis un modèle avec builtin-http : ce parcours créait directement la suite en conservant ses moteurs. Ajout d’un choix avant toute instanciation, y compris pour la composition. Local garde les étapes originales ; Fleet propose une campagne GET distincte sur la même cible, avec reconnaissance et vérification des bots/budget avant création. Les suites Fleet complètes restent hors périmètre et cette différence est affichée ; aucune conversion silencieuse ni migration des campagnes existantes.

Build460, source26 `89a6621006d361bb471f4645a62d3743dc9a6299474cfa20843b4cddae19c05b`. Tests locaux 1 135 backend/424 frontend ; natifs 34 backend/55 frontend ; typecheck, lint, build et API/UI vérifiés. Recette mTLS en lecture seule et capture de la boîte de choix examinée ; modèle et composition vérifiés, cible conservée vers Fleet, aucun appel API de mutation depuis le navigateur. Sauvegarde PostgreSQL, comptes/inventaire inchangés et rollback build459 conservé. Session de recette supprimée. Aucun lancement de campagne ni reprise de la roadmap générale.

### 14 octobre — essais réels de modèles demandés par l’utilisateur (build460)

Cible dédiée autorisée : `http://46.28.109.92/`. Trois campagnes bornées terminées :

| Entrée / périmètre testé                                                                   | Campagne                               | Résultat                                                                      | Sonde |
| ------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- | ----- |
| Quick readiness check → alternative Fleet GET, 2 bots, 3 RPS total, 20s                    | `ed89679b-a320-4a1b-a6f4-28b4ac842cd5` | COMPLETED, 2 SUCCEEDED, 50 HTTP2xx, 0 échec                                   | 4/4   |
| Capacity assessment → alternative Fleet GET, 3 bots, 3 RPS total, 20s maximum, Kill global | `2c8f7fcf-22e7-4ff7-b9fd-b2f5cd9c757c` | KILLED_MANUAL, 3 STOPPED, 26 HTTP2xx, 0 échec                                 | 2/2   |
| Quick readiness check → Local, seul Smoke original, 10 RPS, 20s                            | `456b29ad-20e8-40ee-827e-9c092386c200` | COMPLETED, builtin, 200 HTTP2xx, 0 échec ; étape Baseline non lancée, annulée | 4/4   |

Sélection Local/Fleet testée depuis les modèles de l’UI, puis confirmation explicite des deux variantes Fleet, compteur actif vérifié avec deux et trois bots, fin et arrêt acquittés dans Run Theater. Création du modèle local via UI, exécution explicite du Smoke via API authentifiée et confirmée, affichage terminé sans compteur Fleet vérifié. La suite locale complète et le scénario de capacité original n’ont pas été exécutés ; les variantes Fleet restent les GET bornés distincts annoncés dans le choix de générateur.

76 reçus nginx de la cible collectés via SSH, importés avec provenance opérateur et concordant exactement avec les deux rapports Fleet (50+26). Source publique observée unique `31.31.74.187`, IP privées distinctes conservées. HTML et exports Fleet vérifiés, doublon d’import rejeté. Preuves privées : `~/.local/share/ddostester-lab-evidence/2026-10-14-preconfigured-campaign-tests-01`. Comptes/inventaire préservés, aucun run encore actif et session temporaire supprimée après recette. Ces essais valident le parcours testé et ne certifient pas une capacité maximale ni une résistance DDoS. Aucun déploiement ni nouveau développement demandé par cette recette.

## Refonte DRS du 14 octobre 2026

Les 281 campagnes historiques ont été archivées (183 nouvelles archives, 98 déjà archivées), sans suppression des campagnes, résultats ou audits. Aucun lancement n'a accompagné cette opération.

Le serveur démarre par défaut avec `CAMPAIGN_CATALOG=drs-fleet`. Le catalogue expose uniquement les douze profils L7 référencés dans le dépôt comme DRS v3 / P26-20371. Le document original n'a pas été vérifié indépendamment : ce catalogue ne constitue pas une certification DRS. Seul le profil GET borné est configurable ; les onze autres sont désactivés et ne sont jamais remplacés par un générateur local. Les anciennes voies de création de modèles et de suites sont refusées dans ce mode.

La capacité du registre est de 5 000 appareils répartis sur 100 sites. La pagination, les limites, la persistance PostgreSQL et les recherches authentifiées par identifiant ont été testées. Cela ne démontre ni 5 000 agents connectés ni leur exécution simultanée. Les limites d'exécution restent à **3 agents, 15 requêtes/s, concurrence 6 et durée 60 secondes**. Aucun cluster infrastructure ni adaptateur Kusa n'a été déployé.

Chaque appareil possède un identifiant global et un `siteId`. Les IP privées doivent être distinctes dans un site ; des réseaux privés de sites différents peuvent se recouvrir. Une modification du site ou de l'IP révoque l'enrôlement. La sélection de campagne conserve les identifiants explicites entre les pages et n'effectue aucun remplacement silencieux. Les mesures conservent le site déclaré lors du lancement.

Les erreurs internes de lancement renvoient une référence de diagnostic, également conservée dans la campagne ; les détails privés restent dans les journaux serveur. Les campagnes archivées ne peuvent plus être exécutées. Les autorisations de cible, budgets, sonde indépendante et mécanismes d'arrêt existants restent obligatoires.

Validation locale : typecheck et build, 1 142 tests backend réussis (31 conditionnels ignorés), 426 tests frontend réussis, 43 tests PostgreSQL et restauration chiffrée réussis. Recette visuelle isolée avec 5 000 entrées fictives et 100 sites ; aucune campagne créée ou exécutée pendant cette recette. Les travaux locaux préexistants sont préservés.

À poursuivre : vérification du standard original, intégration infrastructure/Kusa et qualification de capacité. L'inventaire multisite seul n'offre pas un provisionnement Kubernetes ni une preuve de capacité sous charge.

### Livraison vérifiée — build 461

La source `bc5310803f6e20704252e512eef31f6e7c75899885120d0b63c09f39e20d4312` a été construite et promue sur le VPS le 14 octobre 2026. Vérification des assets et de l'API, 50 tests backend et 57 tests frontend réussis sur le VPS. Les 11 comptes, l'administrateur unique et les trois appareils existants ont été conservés ; aucun lancement actif lors de la promotion. La version précédente est disponible pour rollback.

L'API confirme douze profils dont un configurable, 281 campagnes historiques archivées et un seul brouillon non archivé : `d6de8384-128f-4839-9709-982c681286be`, statut `PENDING_APPROVAL`, GET Fleet, 3 requêtes/s, concurrence 3, durée 20 secondes. Ce brouillon n'a pas été exécuté. Les sessions temporaires de vérification ont été supprimées. La documentation reste distincte d'une preuve de conformité au standard original ou d'une validation d'exécution à 5 000 bots.
