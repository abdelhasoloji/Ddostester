# Rotation et révocation des identités de flotte

Deux chemins existent : les missions persistantes actuelles utilisent une clé d’enrôlement applicative et le mTLS du proxy ; le coordinateur Jobs ci-dessous possède sa propre politique de certificats. Le chemin Jobs est désactivé en production. La procédure décrite ne prouve pas une rotation de bout en bout des trois workers actuels. Voir [setup actuel](current-setup.md) et [gestion de flotte](fleet-management.md).

Le coordinateur exige une chaîne mTLS valide et un CN présent dans le registre de sites `FLEET_SITES` (format `agent@site`, séparé par des virgules ; un agent par entrée, au plus `FLEET_LIMITS.maxAgents`). Le CN reste l’identité de l’agent ; le site dit où il s’exécute et apparaît dans `/api/fleet/status`. La configuration `FLEET_REVOKED_CERT_SHA256` ajoute une liste de certificats feuilles révoqués : SHA-256 du DER, 64 caractères hexadécimaux sans séparateurs, séparés par des virgules, au maximum 128. Une entrée malformée empêche le démarrage. Une liste vide conserve le comportement initial.

### Un site distant exige un SAN côté serveur

Un worker sur un autre serveur valide le certificat du coordinateur contre la CA **et le nom d’hôte** qu’il appelle (`FLEET_CONTROL_URL`). Le certificat serveur doit donc porter ce nom, en plus des noms de laboratoire actuels (`lab-fleet`, `lab-fleet.ddostester-lab.svc`, `…svc.cluster.local`). Ajouter une entrée `DNS:<nom-joignable-depuis-le-site>` dans les SAN émis par `scripts/operations/lab-identities.py` (ligne ~33), réémettre le certificat serveur, puis vérifier :

```
openssl x509 -in server.crt -noout -ext subjectAltName
```

Le client utilise `rejectUnauthorized: true` : sans ce SAN, le worker refuse la connexion à chaque poll et la boucle s’arrête après N échecs consécutifs. Les SAN ne sont pas modifiables dans le code TypeScript — c’est une propriété du certificat, donc de la procédure d’émission.

La révocation est vérifiée à chaque requête claim/heartbeat/result avant accès au coordinateur. La chaîne TLS peut rester valide ; l’autorisation applicative renvoie 403 pour cette feuille. Retirer un CN de la liste d’agents désactive toute l’identité, alors que révoquer son ancien fingerprint permet d’accepter une nouvelle feuille du même CN.

Pour un renouvellement planifié, arrêter les campagnes et attendre la fin des Jobs. Créer une nouvelle clé/feuille auprès de la CA du laboratoire, préserver CN, usages et courte durée. Remplacer uniquement le Secret de cet agent, puis ajouter le fingerprint de l’ancienne feuille à la configuration du coordinateur. Redémarrer le coordinateur pour appliquer la liste. Les secrets et la clé de CA restent hors Git ; la clé de CA reste hors Kubernetes. Tester ancien certificat refusé, nouveau accepté et identité inconnue refusée avant de réautoriser des missions.

En incident, révoquer la feuille ou désactiver l’identité et redémarrer le coordinateur. Un agent privé de heartbeat doit s’arrêter à expiration de son bail ; conserver les preuves avant nettoyage. Le renouvellement ne réinitialise ni claim, tentative, budget, deadline ou séquence. Une mission perdue reste perdue ; ne pas la rejouer pour compenser le trafic absent. La recette de cet arrêt en cluster reste requise avant d’affirmer une révocation opérationnelle de bout en bout.

La liste est chargée au démarrage, sans hot reload ni CRL/OCSP. Cette configuration est spécifique au laboratoire et ne remplace pas la gestion de certificats retenue par infrastructure. Un incident impliquant la CA nécessite une nouvelle CA et une rotation complète ; une simple liste de feuilles ne suffit pas.

Validation actuelle : vrais certificats et serveur HTTPS loopback dans `backend/test/fleet-mtls.test.ts`, sans trafic cible. Ancienne feuille 403, nouvelle feuille portant le même CN 200, exactement un appel au coordinateur. Les recettes de rotation Linux/Mac et leur délai d’arrêt ne sont pas encore déclarées validées. Les la qualification en cluster de ce contrôle de fingerprint reste distincte des tests source.
