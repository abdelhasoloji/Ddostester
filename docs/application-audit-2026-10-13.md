# Audit de Ddostester — 13 octobre 2026

## Conclusion et périmètre

Le contrôle des comptes est cohérent après la refonte, mais plusieurs garanties de
sécurité et de mesure restent incomplètes. Corriger les constats P1 avant de
connecter l'orchestration au cluster infrastructure. Le laboratoire isolé peut
servir à valider ces corrections, avec des réponses simulées et sans campagne externe.

Audit du code local de `main`, base `d98db08`, avec les modifications non commitées
conservées. Revue des comptes, API, campagnes, générateurs, sondes, rapports,
assistant, persistance et déploiement. Aucun changement fonctionnel, lancement de
campagne ou déploiement effectué. Pas de nouvel audit dynamique du VPS : son état
est décrit par le compte rendu de release existant, pas revalidé ici.

P1 = avant intégration infrastructure ; P2 = prochaine consolidation ; P3 = entretien.
Les sévérités ci-dessous concernent le produit et sont distinctes de celles de npm.

## Constats prioritaires

### A01 — P1 / élevée : sonde de reconnaissance hors allowlist

`backend/src/modules/recon/fetch.ts`, `runRecon` : `probeAllowed` est calculé mais
n'entraîne aucun refus. Après validation du target, cinq appels au `probeUrl` sont
effectués même lorsque son hôte est absent de l'allowlist. `/api/recon` est accessible
avec `campaign:read`, donc également au viewer. La réponse preflight arrive après
les requêtes et ne constitue pas une protection.

Reproduction confirmée avec `fetch` simulé : target autorisé, probe non autorisée,
cinq appels enregistrés sans trafic réseau. Refuser target ET probe avant toute
I/O, avec protocoles HTTP(S) validés. Validation : aucune invocation du transport
pour une URL refusée, quelle que soit la permission de lecture du demandeur.

### A02 — P1 / élevée : redirections échappant à l'allowlist

Recon `get()` et `deploy/probe-agent/probe-agent.mjs` utilisent explicitement
`redirect: 'follow'`. La sonde locale (`Probe.acquireLocal`) conserve le comportement
automatique de fetch. Le script k6 généré ne fixe pas `maxRedirects`; Locust ne
fixe pas `allow_redirects`. La destination initiale seule est contrôlée. À l'inverse,
le générateur builtin impose déjà `redirect: 'manual'`.

Un endpoint autorisé qui redirige peut donc provoquer des requêtes vers une autre
destination, y compris sur le réseau accessible au serveur. Dans les adaptateurs,
les requêtes supplémentaires peuvent aussi fausser le budget de débit.

Uniformiser le refus des redirections automatiques sur tous les transports et
adaptateurs ; si un suivi est nécessaire, valider chaque saut avant émission et
le compter dans le budget. Compléter par une politique réseau de sortie Kubernetes
et une politique explicite pour DNS, ports et origines autorisées. Aucun test actif
de redirection externe n'a été exécuté.

Sources officielles : [options k6](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/)
(redirections autorisées par défaut), [Requests](https://docs.python-requests.org/en/latest/user/quickstart/).
Les autres adaptateurs doivent recevoir des tests de conformité ; leur comportement
réel n'est pas certifié par cet audit.

### A03 — P1 / élevée : indépendance de la sonde et arrêt automatique

`modules/probe/probe.ts`, `evaluateAutoKill` : lorsque `generatorSucceeding()` est
vrai, le compteur d'indisponibilité est remis à zéro puis la fonction retourne
avant les contrôles de disponibilité ET de latence. Le runner active ce signal
dès cinq succès supplémentaires dans son tick, sans exiger un taux de succès élevé.
Quelques succès du générateur peuvent donc masquer une dégradation de la sonde.

Le runner remplace aussi les comptages légitimes du WRS par ceux du générateur
lorsque `probeContended` est vrai. Le drapeau est conservé, mais l'inférence
« succès du générateur = disponibilité légitime » n'est pas une preuve indépendante,
notamment si les endpoints, caches ou profils de trafic diffèrent.

Reproduction pure confirmée : une sonde indisponible au-delà du seuil ne déclenche
pas l'arrêt quand le signal générateur est vrai. Conserver les mesures brutes,
ne pas inhiber les seuils de sécurité avec ce signal, et utiliser une sonde à
source distincte pour distinguer contention et panne. Marquer les résultats
incertains au lieu de substituer une disponibilité favorable. Valider notamment
latence excessive et disponibilité faible malgré quelques succès générateur.

### A04 — P1 / élevée : arrêt des processus externes non garanti

`agents/proc.ts`, `runProcess` : l'abort envoie seulement SIGTERM au processus
direct ; absence de délai puis SIGKILL, gestion des descendants et vérification
d'un signal déjà aborted. `binaryAvailable` n'a aucun timeout. Les sorties stdout
et stderr sont accumulées sans plafond. Un binaire bloqué ou ignorant SIGTERM
peut empêcher la fin du run ou continuer après une annulation.

Mettre un superviseur avec deadline absolue, abort avant spawn, arrêt du groupe
de processus, grace bornée puis arrêt forcé et plafond de sorties. Valider avec
des processus factices qui ignorent SIGTERM, créent un descendant ou écrivent
beaucoup. Ne pas lancer de générateur pour ces tests.
Source : [Node.js child_process](https://nodejs.org/download/release/v25.9.0/docs/api/child_process.html).

### A05 — P1 / élevée : limites opérationnelles revalidées selon l'acteur

`app.ts`, `runCampaign` ne rappelle `createCampaign(...effectiveCaps)` que pour
l'owner en mode single. Les parcours team et scheduler peuvent reprendre une
campagne enregistrée avant la baisse des limites opérationnelles. Les moteurs
continuent à valider le plafond immuable, ce qui protège le plafond mais pas les
limites opérationnelles actuelles. Le probe/reference doit également être
revalidé avant toute I/O, pas seulement la configuration du générateur.

Centraliser la validation de départ pour tous les acteurs et suites : état,
autorisations courantes, toutes les URLs, limites courantes, budget total et
approbations. Test attendu : une campagne auparavant admissible est refusée après
réduction du cap ou révocation de son probe, quel que soit le mode.

## Consolidation nécessaire

### A06 — P2 / moyenne : corps HTTP chargés entièrement en mémoire

Recon, sonde locale, agent distant et builtin appellent `arrayBuffer()` ou `text()`.
Les limites de corps recon/erreur sont appliquées après lecture complète. Une limite
de temps ne borne pas le volume reçu ; avec la concurrence, cela peut épuiser la
mémoire du contrôle plane et dégrader les mesures. Lire en streaming avec plafond
d'octets et annulation ; séparer drainage sans accumulation et capture bornée.

### A07 — P2 / moyenne : audit des mutations métier en best effort

`app.ts`, `auditAs` intercepte les erreurs DB et ne les propage pas. Une modification
de limites, une autorisation ou un lancement peut réussir sans entrée d'audit.
Les opérations utilisateurs sont mieux protégées par leur transaction atomique.
Étendre cette garantie aux mutations métier ; pour les effets externes, persister
l'intention et le résultat avec une stratégie de reprise. La chaîne SHA-256 est
utile pour détecter les modifications internes, mais sans tête exportée vers un
système indépendant elle ne prouve pas l'absence de troncature ou de réécriture.
Cette dernière limite est déjà reconnue dans `modules/audit/integrity.ts`.

### A08 — P2 / moyenne : déploiement pouvant annoncer un faux succès

`deploy/update.sh` poursuit vers `health_ok` après échec de `deploy_current` ;
l'ancien service encore sain peut conduire à un succès. `/ready` ne compare pas
la release attendue à celle réellement servie. Le drop-in de la release actuelle
pointe ailleurs que le checkout traditionnel : ce script seul ne la promeut pas.
Il exécute aussi `git reset --hard`, dangereux si des travaux locaux existent.

Utiliser des releases immuables avec manifeste, refuser un checkout modifié,
basculer explicitement le service et vérifier source stamp API ET assets UI.
Un échec de build doit rester un échec même si l'ancienne release répond.
Ne pas relancer setup sans précaution : il réécrit le fichier de secrets et
n'intègre pas explicitement la migration des comptes avant le premier démarrage.

### A09 — P2 / moyenne : authentification coûteuse sans budget global

`auth/passwords.ts` utilise `scryptSync`, qui bloque l'event loop. Le verrouillage
login est par email+IP ; changer l'email contourne le budget de source. Il manque
un plafond global et un plafond par source avant le calcul coûteux. Les corps
login sont castés en TypeScript sans schéma de validation runtime ; des types
incorrects peuvent produire des erreurs 500.

Passer au hash asynchrone avec concurrence limitée, ajouter rate limiting avant
hash et schémas Fastify. Valider que des tentatives sur des emails variés ne
dégradent pas les endpoints de santé ni la sonde.

### A10 — P2 / moyenne : JWT complet dans les URLs de lecture

`frontend/src/api.ts` ajoute le token de session aux URLs rapports/export/SSE.
La sérialisation des logs API masque `token`, et Referrer-Policy réduit certaines
fuites, mais historiques navigateur et éventuels logs proxy restent concernés.
Utiliser des jetons de lecture courts et limités à une ressource, ou un transport
authentifié sans token dans l'URL. Le stockage local du token reste exposé à toute
exécution JavaScript dans l'origine ; la CSP actuelle constitue une défense utile.

### A11 — P2 / moyenne : état runtime non partagé et nettoyage incomplet

Kill registry, séquences de suites et limite de concurrence vivent dans le processus.
Plusieurs réplicas Kubernetes ne partageraient ni verrou ni arrêt ni budget.
`runCampaign` enregistre le kill puis sauvegarde RUNNING et vérifie la disponibilité
des moteurs avant d'entrer dans le try/finally principal : un échec de préparation
peut laisser un slot enregistré. Le shutdown ferme API/DB sans déclencher
explicitement tous les kills ; le comportement des enfants dépend du superviseur.

Limiter le contrôle plane à un replica dans le premier lab. Encadrer toute
préparation par cleanup, puis introduire leases, identité de run, arrêt acquitté
par agent et budget global persistant avant une orchestration distribuée.

### A12 — P2 : dépendances de production signalées par npm

`npm audit --omit=dev --json` du 13 octobre : trois packages affectés, un high et
deux moderate, zéro critical. Les correctifs sont indiqués disponibles.

| Package installé        | Signal npm                              | Correctif minimal signalé |
| ----------------------- | --------------------------------------- | ------------------------- |
| brace-expansion 5.0.9   | high, récursion/CPU DoS                 | 5.0.12                    |
| fast-uri 3.1.7 et 4.1.4 | moderate, normalisation/injection URI   | 3.1.8 / 4.1.5             |
| fastify 5.12.4          | moderate, exception sur trailers HTTP/2 | 5.12.5                    |

Présence confirmée avec `npm ls`, exploitabilité non démontrée. Fastify est
initialisé sans HTTP/2 dans le code inspecté ; brace-expansion est transitif via
le service statique. Ne pas assimiler la sévérité d'une dépendance à une faille
exploitable de l'application. Mettre à jour le lock dans un changement séparé,
rejouer la vérification puis réauditer ; aucune installation effectuée ici.
Advisories : [brace-expansion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[fast-uri](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj),
[Fastify](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc).

## Mesures, assistant et documentation

- Des réponses HTTP réussies ne prouvent pas que l'origine a reçu la requête :
  les métriques `origin_rps` utilisent pourtant les succès générateur. Même
  ambiguïté pour `failed/sent` présenté comme absorption : erreurs réseau et
  erreurs origine peuvent y entrer. Nommer ces métriques selon leur observation
  réelle et réserver origine/absorption à la télémétrie corroborée.
- L'assistant proxifie du texte ; ses propositions passent par les endpoints
  gouvernés pour les actions. La mise sous tension GPU est contrôlée et auditée.
  Le chat est disponible au viewer et n'a pas de quota global de concurrence/coût.
  Prévoir quota, backpressure et limitation du buffer SSE avant utilisation large.
- `INSECURE_TLS=true` désactive la vérification pour tout le processus, pas juste
  la cible. Préférer CA interne et refuser ce mode sur un déploiement connecté.
- `docs/operations.md` annonce `RETENTION_DAYS=0` pour désactiver la rétention,
  mais `server.ts/intEnv` refuse zéro. Harmoniser et tester le contrat.
- SECURITY conserve une règle générale d'approbateur distinct alors que son ajout
  single décrit l'exception owner. Réécrire les règles par mode. Le commentaire
  de recon promet un refus de probe hors allowlist que le code n'applique pas.
- Les documents anciens doivent être reconciliés avec `docs/single-user.md` et
  le compte rendu de release, notamment migration obligatoire, profils gérés et
  procédure réelle de promotion. Le document Kubernetes doit intégrer A01–A05
  et conserver un contrôle plane unique tant que les verrous restent en mémoire.

## Points solides et validation

Capabilities issues du serveur, permissions API, owner unique persistant,
protection contre sa suppression/démotion, invalidation par tokenVersion,
mutations utilisateurs et audit transactionnels. Plafonds immuables centralisés,
validation initiale des campagnes, confirmation explicite owner, refus des
redirections builtin, CSP, CORS fermé par défaut et bind loopback par défaut.

115 tests ciblés réussis : RBAC, single-user, user-management, intégrité audit,
génération/parsing adaptateurs et recon pure. Exécutés sur le staging de la release
précédemment vérifiée ; ce résultat ne certifie pas les parcours réseau ni tous
les changements locaux. Deux reproductions supplémentaires utilisent le code
local et des appels simulés/purs. La vérification complète précédente reste
documentée dans `access-release-2026-10-13.md`, sans être présentée comme rejouée.

Limites : pas de pentest externe, de charge, de nouvelle validation du VPS,
d'audit des comptes cloud/Kusa ni des vrais binaires externes. Analyse des sources
et du lock, pas une certification de sécurité. Les constats de logique sont
séparés des alertes de dépendances et des hypothèses de déploiement.

## Ordre d'implémentation proposé

1. Politique de destinations commune : probe/recon, redirects, protocoles,
   allowlist courante et caps pour chaque départ. Régressions simulées A01/A02/A05.
2. Sonde indépendante et critères d'arrêt conservateurs ; métriques brutes et
   indication explicite d'incertitude. Régressions A03 et attribution des rapports.
3. Superviseur des moteurs, deadlines, buffers bornés, cleanup et shutdown.
4. Transactions métier/audit, validation des entrées et budgets login/assistant.
5. Lock corrigé et déploiement reproductible avec vérification de release.
6. Lab Kubernetes à un contrôle plane, agents à budgets agrégés, sonde indépendante,
   egress fermé et arrêt acquitté ; ensuite seulement connexion infrastructure.
