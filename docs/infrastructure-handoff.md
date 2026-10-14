# Dossier de candidature infrastructure — laboratoire Ddostester

Statut : recette en cours, raccordement non autorisé par ce document. Les preuves datées sont dans [le journal d’exécution](./roadmap-execution-2026-10-13.md). Ce dossier ne déclare pas les portes G0–G4 entièrement passées.

## Référence et architecture

Le contrôle Linux utilise l’image `docker.io/library/ddostester-lab-control@sha256:33d1162c596f01ef9d6ae3e19003baa5c7b5a0eccbf2eae407dc78b5963fd446`, source identifiée `snapshot:f30b61180d64658e0c66d532de5f9b236f27822ec121a42b74ec17233f8f9aa1`. API/readiness/assets UI sont vérifiés contre le manifeste de cette image. La sonde utilise `docker.io/library/ddostester-lab-probe@sha256:13c48bc25ba2d5c063ee37dc17a59578f102569641ca5b587bf68835b2f63d5e`.

Composants : contrôle singleton, coordinateur mTLS, PostgreSQL séparé, trois Jobs d’agents HTTP bornés, cible nginx dédiée avec reçus, sonde indépendante avec diagnostic de ressources. Les schémas, limites et mesures réutilisent les modules campagnes, auth, audit, sondes, télémétrie et rapports du produit. Kusa reste un proxy de conversation/proposition ; toute action suit les routes gouvernées existantes.

Mac : kind 0.33.0, Kubernetes 1.37.0, Calico 3.33.0, PodCIDR 10.246.0.0/16 et ServiceCIDR 10.97.0.0/16. Linux : k3d 5.9.0 / K3s 1.37.1+k3s1, flannel et contrôleur NetworkPolicy K3s conservé, PodCIDR 10.247.0.0/16, ServiceCIDR 10.98.0.0/16, réseau Docker 172.30.94.0/24, API sur loopback 16643. Les digests outils sont dans `deploy/kubernetes/overlays/k3s/tools.lock.json`.

Le laboratoire Linux actuel est un test de compatibilité sur le VPS de monitoring existant, avec nœud Docker limité à 1,5 CPU et 4 Gio. Il ne remplace pas la recette finale sur VPS dédié distinct demandée en R10. La contention observée et les plafonds ne permettent pas une mesure de capacité du produit ou d’Internet.

## Matrice de flux

Les règles sources sont `deploy/kubernetes/base/policy.yaml`, deny ingress/egress par défaut. Les autorisations dans le namespace lab sont :

| Source                  | Destination           | Port / fonction                               |
| ----------------------- | --------------------- | --------------------------------------------- |
| Agents, sonde, contrôle | Cible dédiée          | TCP 8080, HTTP borné                          |
| Contrôle                | Sonde                 | TCP 8099, mesure authentifiée                 |
| Contrôle                | Reçus cible           | TCP 9101, télémétrie                          |
| Agents                  | Coordinateur          | TCP 8443, mTLS                                |
| Contrôle, coordinateur  | PostgreSQL            | TCP 5432                                      |
| Pods lab                | CoreDNS sélectionné   | UDP/TCP 53, DNS interne                       |
| Contrôle                | API Kubernetes du lab | Ports/IP explicites de l’overlay et bootstrap |

Le DNS du lab ne relaie pas vers un résolveur externe. L’accès opérateur passe par tunnels loopback explicites, sans NodePort ni LoadBalancer. La présence des règles ne prouve pas leur enforcement : les tests négatifs réseau, DNS, autres namespaces et destinations doivent être rejoués sur le CNI infrastructure avant raccordement.

## Droits, identités et arrêt

Namespace `ddostester-lab`, Pod Security restricted, non-root, filesystem runtime readonly, capabilities supprimées. Seul le contrôle reçoit le ServiceAccount : Jobs create/get/list/delete, Pods get/list, pods/log get dans ce namespace ; aucun accès RBAC aux Secrets. Le droit de créer des Jobs reste puissant : l’infrastructure doit examiner les admissions et l’accès indirect aux identités montables avant un environnement partagé. Ce RBAC ne constitue pas une isolation multi-tenant.

CA privée hors cluster, identités mTLS individuelles one/two/three, secrets propres à chaque laboratoire, CA 30 jours et feuilles 14 jours. Rotation et révocation opérationnelles restent à recetter. L’agent ne reçoit ni shell arbitraire ni kubeconfig ; les missions sont versionnées, bornées et liées à run/agent/attempt/hash. Le coordinateur applique claims atomiques, fencing et résultats idempotents.

Enveloppe : trois agents maximum, 15 RPS et six connexions agrégés, durée 10–60 s, heartbeat 2 s, lease 6 s, grâce 2 s, objectif d’absence de nouvelle requête après perte de contrôle en 8 s. Jobs sans retry automatique, deadline et TTL. Budget perdu non réalloué automatiquement. La recette naturelle seule ne prouve pas cet objectif sous panne.

## Preuves et opérations

La recette Linux `d4819dcb-fcdd-4a91-b856-77827131788f` termine trois shards SUCCEEDED : 54 requêtes et 54 reçus complets, sources privées 10.247.0.27/.28/.29. Les 29 mesures sonde portent le diagnostic, zéro throttling observé ; le délai de boucle manque pour ces fenêtres courtes et la confiance reste dégradée. Trois snapshots de Jobs sont conservés avant nettoyage. L’export et son checksum sont vérifiés par `lab-smoke.py --require-complete`.

L’arrêt manuel Linux `aed36b5e-5a0a-4132-b946-beaa762acee3` termine trois STOPPED et KILLED_MANUAL. Les reçus cible montrent la dernière nouvelle requête 1 862 ms après l’ancre prise sur la cible avant envoi de l’arrêt : borne conservatrice sous huit secondes, avec neuf secondes d’observation après settlement et dérive wall/monotone nulle. `lab-stop-check.py` conserve ancre, acquittement, run et reçus. Cette preuve d’arrêt manuel ne remplace pas les scénarios de perte de contrôle, réseau ou agent.

La coupure du coordinateur Linux `c02d7aea-f30e-4b20-bfd9-87444bdf1330` passe la même limite : dernière nouvelle requête 3 346 ms après l’ancre, dérive 1 ms, trois sources privées. Les trois shards sont LOST et la mesure reste incomplète faute de résultats finaux reçus. Le coordinateur est temporairement réduit à zéro replica puis restauré à un replica Ready dans un finally. Cette recette prouve l’arrêt de génération observé pour cette indisponibilité ; elle ne prouve pas encore le crash du contrôle ou une partition CNI.

Le filtrage de nouvelles connexions est vérifié sur Linux avec `linux-cni-check.py` : cible/coordinateur accessibles à un Pod portant la sélection réseau d’agent ; PostgreSQL/sonde refusés malgré leur disponibilité depuis le contrôle. Retirer la règle vers le coordinateur refuse ses nouvelles connexions tout en conservant la cible. Après restauration, les deux redeviennent accessibles. Le Pod n’a ni Secret ni ServiceAccount, n’envoie aucun payload HTTP et est nettoyé. Un rollback hôte est armé avant modification. Ces preuves de connexions fraîches ne certifient pas une coupure de sockets déjà ouverts.

Le crash du processus contrôle Linux passe la borne de huit secondes : dernière nouvelle requête 5 902 ms après l’ancre hôte juste avant signal KILL, erreur de compatibilité d’horloge et dérive nulles, trois sources privées. Le contrôle redémarre Ready ; la campagne est CANCELLED et le parent durable STOPPING, sans replay. Trois Jobs terminés et logs sont conservés avant nettoyage. Limite mise en évidence : aucun CampaignRun final n’est persisté quand le contrôle meurt avant son `saveRun`; l’état durable de flotte et les reçus subsistent, mais leur restitution comme rapport interrompu reste à compléter. Ce manque empêche de déclarer R07/R08 terminés malgré la preuve d’arrêt.

Runbooks : [opérations](./operations.md), [récupération propriétaire](./owner-recovery.md), [sources identifiées](./source-snapshots.md), scripts `linux-lab-{create,verify,import,bootstrap,delete}.py` et `lab-smoke.py`. Les anciennes images immutables sont conservées pour rollback. La sauvegarde chiffrée et le témoin d’audit de production ont leurs preuves propres ; ils ne certifient pas encore la restauration du PostgreSQL Kubernetes du lab.

## Décisions externes et validations restantes

Infrastructure doit valider CIDR/SNAT, CNI et admissions, stockage/PVC, isolation physique si nécessaire, quotas, chemins opérateur et IP publiques. Aucun raccordement, spoofing ni campagne publique n’a été effectué.

Avant G4 : recette Linux sous panne/coupure/reprise, rotation/révocation certificats, restauration de la DB lab, collecte/dashboards lab, parcours navigateur authentifiés, matrice des six moteurs réels, contrat réel Kusa et release Git revue. Le VPS dédié et la compatibilité du cluster de l’équipe restent des dépendances externes non vérifiées. Les garanties du lab ne sont pas une certification IoT réel, HA, DDoS Internet ou réglementaire.
