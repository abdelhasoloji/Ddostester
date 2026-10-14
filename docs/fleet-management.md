# Fleet management — incréments utilisables

## État actuel : build 455, missions fonctionnelles

La reprise autorisée porte exclusivement sur les trois agents du VPS lab. Dans
**Fleet → Fleet missions**, l'administrateur sélectionne les agents, confirme le
lancement, suit leurs compteurs et commande leur arrêt. La roadmap générale
reste suspendue hors de ce périmètre. Voir [contrat et recette](fleet-missions.md).

Les trois agents actuels sont `lab-iot-01` / `10.247.0.71`, `lab-iot-02` /
`10.247.0.72` et `lab-iot-03` / `10.247.0.73`. Ils annoncent
`fleet-mission-agent/v1`, conservent leurs fiches d'inventaire et disposent de
clés renouvelées. Les pods redémarrent leurs processus après leur cycle quotidien ;
l'ancienne échéance terminale de 24 heures a été retirée. Requests par agent :
50m CPU/128Mi ; limits : 250m/256Mi. Les expirations de clés et certificats restent
applicables et leur renouvellement nécessite une opération explicite.

La recette finale confirme 51 requêtes HTTP 200 sur une mission normale et 21
sur une mission arrêtée. Les trois arrêts sont acquittés. Les traces de réception
confirment les trois IP privées et correspondent exactement aux compteurs des
agents. Lancement et arrêt ont également été exercés depuis les boutons de
l'interface déployée, avec trois acquittements.

Une première recette a révélé des fichiers du benchmark illisibles par l'utilisateur
non root. La cible a été corrigée avec un montage de contenu en lecture seule,
et le Dockerfile corrige maintenant les permissions pour les prochaines images.
Les résultats de cette première tentative restent dans l'historique.

La sonde indépendante a enregistré 89 réponses sur 90 échantillons, avec un timeout
sur le premier. Un contrôle séparant l'initialisation de la mesure confirme ensuite
30 réponses sur 30 pendant une nouvelle commande depuis l'interface. Ces mesures
valident le fonctionnement ; elles ne constituent pas une certification de capacité
ou un score de résilience. Les sections suivantes retracent les incréments antérieurs.

## Inventaire (build 453)

La page Fleet permet d'enregistrer, modifier et supprimer les appareils, rechercher leur identité ou IP, et filtrer par groupe. Le profil sensor/camera/gateway/generic et les notes sont des métadonnées. Les IP doivent appartenir aux plages privées RFC1918 ; agent ID et IP ne peuvent pas être dupliqués. Les administrateurs modifient l'inventaire, les autres profils autorisés le consultent.

## Connexion des agents

L'incrément d'enrôlement ajoute une identité d'accès par appareil, distincte des sessions utilisateurs. Depuis la ligne de l'appareil, Enroll agent produit un fichier téléchargeable ; télécharger également le client proposé. La clé ne sera plus disponible après fermeture : une nouvelle génération remplace la précédente. Elle expire après sept jours ; rotation et révocation sont auditées et prennent effet sur le prochain heartbeat. Changer l'agent ID ou l'IP révoque aussi l'enrôlement ; changer le nom/groupe/notes le conserve.

Sur l'hôte de l'agent, avec Node.js 22.19 ou ultérieur :

```sh
chmod 600 fleet-agent-01.json
node heartbeat-agent.mjs fleet-agent-01.json
```

Adapter le nom du fichier téléchargé. Le client envoie uniquement un heartbeat d'inventaire toutes les cinq secondes ; il ne lance aucun trafic de campagne. Durée par défaut : une heure ; le second argument accepte une durée de 1 à 86400 secondes. SIGINT/SIGTERM l'arrête. Son fichier `.state.json` privé conserve la séquence avant chaque émission pour permettre un redémarrage sans rejouer un message. Ne pas partager les fichiers d'enrôlement ou leurs copies. Les heartbeats périmés, répétés, trop fréquents, d'une autre identité ou d'une clé révoquée sont refusés.

Le contrôle doit être accessible par HTTPS ; HTTP n'est accepté que sur loopback pour une fixture ou un tunnel local. Si le proxy exige mTLS, fournir les certificats autorisés via FLEET_AGENT_TLS_CA, FLEET_AGENT_TLS_CERT et FLEET_AGENT_TLS_KEY (chemins locaux). Le client conserve la validation TLS et ne suit aucune redirection. Le certificat de transport requis par le proxy est distinct de la clé d'enrôlement applicative ; télécharger cette dernière ne provisionne pas un certificat.

## Lire l'état

- unenrolled : aucun enrôlement ; awaiting : clé créée, aucun heartbeat reçu ;
- online : heartbeat authentifié reçu par le serveur depuis moins de 30 secondes ;
- offline : dernière réception plus ancienne ; expired : clé expirée ; revoked : accès révoqué.

La page actualise l'inventaire toutes les cinq secondes. En cas d'échec de lecture, la connexion devient inconnue dans l'interface au lieu d'afficher un état online périmé. La dernière réception est horodatée par le serveur. L'IP privée est déclarée par l'agent ; ce mécanisme ne prouve pas le routage, l'absence de NAT, l'IP publique ni l'arrêt d'un processus. Version affichée : inventory-heartbeat/v1.

Le provisioning Kubernetes, les profils générant une activité IoT et les commandes d'activité par appareil restent des incréments séparés. L'enrôlement ne les déclenche pas.

## Flotte initiale, build 454 — historique du 14 octobre 2026

Trois pods heartbeat-only sont déployés dans ddostester-lab sur le VPS 31.31.74.187 et visibles dans le groupe **VPS Lab** de l'application build 454 :

| Agent      | Profil déclaré | IP privée Kubernetes |
| ---------- | -------------- | -------------------- |
| lab-iot-01 | sensor         | 10.247.0.69          |
| lab-iot-02 | camera         | 10.247.0.68          |
| lab-iot-03 | gateway        | 10.247.0.70          |

Les trois pods sont Running/Ready sans redémarrage ; le serveur confirme trois réceptions récentes et le protocole inventory-heartbeat/v1. L'IP du pod est vérifiée avant lancement et doit correspondre à son enrôlement. Chaque agent a son certificat mTLS et sa clé applicative ; aucune session utilisateur ni clé privée de CA n'est montée dans les pods. La confiance des certificats utilisateurs existants est conservée. Les inscriptions sont auditées comme operations:lab-fleet-deploy et les 11 comptes sont préservés.

Image Node déjà en cache et épinglée par digest ; root filesystem en lecture seule, UID 1000, capabilities retirées, token Kubernetes non monté. Par agent : requests 25m CPU/64Mi, limits 100m/128Mi, volume temporaire 16Mi. NetworkPolicy autorise le contrôle 31.31.74.228:443 ; les politiques DNS communes restent applicables. Aucun flux de campagne ni vers la cible de test n'est autorisé pour ces observateurs.

Ce déploiement de recette est borné à **24 heures**, sans retry automatique. Les clés applicatives expirent à sept jours, les certificats clients à quatorze jours. Les profils sont des métadonnées ; l'activité IoT générée et le provisioning piloté depuis l'interface restent à raccorder. En cas de remplacement du pod et changement d'IP, réconcilier l'inventaire et l'enrôlement avant relance. La révocation dans Fleet refuse le prochain heartbeat et arrête le client ; les manifests n'en créent pas automatiquement un autre.

Scripts d'opération : deploy-fleet-observers.py, register-lab-observers.mjs et kubernetes-observer.mjs. Répertoire privé du VPS lab : /var/lib/ddostester-fleet-observers-20261014-01. Les reçus publics d'opération, UID, logs de heartbeats acceptés et vérifications d'inventaire sont conservés hors dépôt ; les clés restent dans les emplacements privés et Secrets dédiés.

## Ancien point de reprise — pause de la roadmap générale

Le 14 octobre 2026, l'utilisateur demande l'arrêt du développement autonome et souhaite avancer ensemble sur la flotte, étape par étape. Ne reprendre aucune implémentation, campagne, promotion, extension de capacité ou modification du cluster sans une nouvelle instruction explicite de l'utilisateur. La roadmap entière reste ouverte. Cette suspension du développement ne demande pas l'arrêt des agents déjà déployés ; leur échéance de recette de 24 heures reste applicable, sans renouvellement automatique.

État livré : production build 454, inventaire CRUD, enrôlement individuel, téléchargement du client, présence authentifiée, rotation et révocation. Trois observateurs sont déployés sur le VPS lab et enregistrés dans VPS Lab. Ils ne génèrent aucun trafic IoT de campagne. Dernière observation : trois online/Ready ; ce résultat est daté, à recontrôler lors de la reprise. Quota actuel : 16 pods, dont 7 composants et 3 bots, soit 6 places supplémentaires et 9 bots théoriques au total ; capacité sous charge non mesurée.

Reste à décider et implémenter ensemble pour la flotte :

1. Choisir le cycle de vie souhaité : recette bornée ou flotte permanente, maintien après redémarrage, renouvellement des clés/certificats et changements d'IP.
2. Provisioning depuis l'interface : créer, démarrer, arrêter, supprimer et remplacer un bot Kubernetes, avec quotas, permissions, audit et preuves d'exécution.
3. Commandes versionnées et acquittement : distinguer demande, réception et résultat. La commande d'arrêt évoquée n'a pas encore été implémentée ; aucun bouton de pause/reprise ou arrêt avec acquittement n'est livré. La révocation existante reste disponible.
4. Activité IoT réelle : profils reproductibles, graines, scénarios et échanges avec la cible dédiée. Les profils d'inventaire actuels sont des métadonnées, pas des comportements générés.
5. Relier l'inventaire et les agents aux campagnes/suites et au coordinateur durable existant, sans augmenter silencieusement les budgets ni rejouer une charge incertaine.
6. Consolider mesures et exploitation : métriques par bot, ressources/throttling, cible/sonde indépendante, dashboard flotte, pertes de connexion et arrêts attestés.
7. Mesurer le nombre de bots admissibles sous les scénarios choisis, puis décider d'une augmentation des quotas ou du dimensionnement.
8. Raccordement infrastructure : réseau privé, CIDR/VPN, IP publiques/NAT et interface réelle Kusa restent à valider.

Les opérations de déploiement sont conservées dans les répertoires privés des VPS et dans fleet-vps-01 hors dépôt. Les sources locales non committées, snapshots et travaux antérieurs sont préservés. Aucun processus de build/déploiement de cette tâche n'était actif lors de la suspension ; le tunnel Grafana préexistant est conservé.

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
