# Corrections de l’audit applicatif — 13 octobre 2026

Les correctifs sont préparés et vérifiés sur une copie isolée du dépôt, puis
appliqués avec contrôle des empreintes des fichiers locaux. Aucun reset Git,
changement de mots de passe, campagne réelle ni déploiement externe n’est inclus
dans cette étape. L’audit original reste un historique des constats.

| Constat | Correction                                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01     | Recon refuse target/probe non autorisés et protocoles non HTTP(S) avant I/O.                                                                                                                                                                         |
| A02     | Redirections désactivées pour recon, sondes, baseline/recovery et les six moteurs ; credentials dans les URLs refusés.                                                                                                                               |
| A03     | Les seuils d’arrêt restent indépendants du générateur. WRS utilise la sonde brute ; désaccord signalé comme incertain. Historique conservé, nouvelle politique de mesure versionnée.                                                                 |
| A04     | Processus en groupes POSIX, abort avant spawn, deadline, SIGTERM puis SIGKILL, sorties et décodage bornés, contrôles de binaires temporisés. Shutdown force aussi l’arrêt des descendants.                                                           |
| A05     | Chaque départ manuel, suite ou scheduler revalide autorisations et limites actuelles ; runner valide toutes les URLs avant baseline.                                                                                                                 |
| A06     | Lectures en streaming avec budget d’octets ; captures de corps séparées du drainage ; agent distant borne aussi son corps de requête.                                                                                                                |
| A07     | Mutation persistée et reçu d’audit actor/entity/hash dans une transaction. Audit détaillé ne masque plus les erreurs. Intentions de lancement/power persistées avant effets externes.                                                                |
| A08     | Checkout modifié refusé, build en release distincte, promotion après gate complet, identité API et assets UI vérifiés ; restauration de l’override précédent si échec. Setup préserve les secrets et vérifie la politique des comptes avant restart. |
| A09     | Scrypt asynchrone avec concurrence/queue bornées ; budgets login par source et global indépendants de l’email ; schémas runtime login/password.                                                                                                      |
| A10     | Liens de lecture sans JWT de session ; cookie HttpOnly/SameSite et Secure hors loopback HTTP. Révocation et changement de profil revalidés ; SSE revalide aussi pendant le flux. Cookie refusé pour les écritures.                                   |
| A11     | Réservation nettoyée même si préparation échoue, fermeture des flux au shutdown, refus des nouveaux départs pendant l’arrêt. Lease PostgreSQL de runtime : un seul contrôle plane par base.                                                          |
| A12     | Lock complet Mac/Linux corrigé, Fastify 5.12.6, fast-uri 3.1.8/4.2.2, brace-expansion 1.1.21/5.0.12, Vitest/coverage 4.1.11. Audit npm complet : zéro vulnérabilité.                                                                                 |

Autres corrections : métriques Prometheus et libellés distinguent succès HTTP,
échecs HTTP/transport et attribution à l’origine/edge ; dashboards associés mis à
jour. Les champs JSON historiques `originRps`/`absorbedRatio` restent lisibles mais
ne constituent pas une preuve d’attribution. Le leaderboard conserve les baisses
de disponibilité observées en affichant l’incertitude.

La revue des moteurs a aussi corrigé la concurrence Vegeta, précédemment élargie
pour atteindre un débit : elle respecte maintenant le budget demandé et sa somme
entre workers. Gatling utilise des utilisateurs concurrents bornés, un throttle
HTTP global et une durée maximale. Un sous-débit doit être rapporté, pas compensé
en augmentant les limites. Les tests vérifient les scripts/arguments générés ;
aucun vrai binaire de génération externe n’a été exécuté.

Assistant : deux conversations actives, cinq requêtes par identité/minute et vingt
par minute globalement ; buffer SSE et backpressure bornés. `RETENTION_DAYS=0`
fonctionne ; TLS non vérifié exige le second opt-in `ISOLATED_LAB=1`. La dépendance
HTTP verrouillée exige Node ≥ 22.19, désormais explicite dans les prérequis.

## Validation et limites

Le gate complet couvre lint, types, tests backend/frontend et builds. Les nouveaux
tests exercent les refus avant transport, le budget de corps, les seuils de sonde,
l’arrêt forcé de processus factices, le rollback d’audit et les transactions
imbriquées, les caps au départ, les cookies/révocations, la fermeture SSE, le refus
d’un checkout modifié et d’un serveur sain servant la mauvaise release. Le test de
l’agent distant n’utilise que des fixtures loopback ; aucune campagne applicative
ni requête vers une cible externe n’est lancée.

Les suites PostgreSQL conditionnelles restent désactivées sans base de test locale.
Le nouveau lease de runtime et le reçu transactionnel PostgreSQL devront être
validés sur une base de recette avant une promotion infrastructure. Les profils,
identités et mots de passe existants ne sont pas migrés à nouveau par ces corrections.

`audit-checkpoint.mjs` fournit un export exclusif de témoin et contrôle sa continuité.
Le collecteur, ses credentials, son stockage immuable séparé et son planning restent
à configurer avec l’infrastructure. La base de l’application seule ne prouve pas
l’absence de réécriture par son administrateur. Aucun service externe n’est créé.

Le laboratoire garde un contrôle plane unique. Les leases distribués, budgets de
shards, stop acquitté par agents et NetworkPolicy avec destinations/ports/DNS du
lab restent les travaux Kubernetes décrits dans `kubernetes-iot-lab.md` ; ils ne
sont pas remplacés par le verrou de runtime. Les IP publiques attendent toujours
la validation de l’équipe infrastructure.

La promotion systemd utilise `40-verified-release.conf`, après l’ancien override de
release `30-access-release.conf`. Le script conserve les secrets et les releases
précédentes. Docker nécessite une promotion explicite d’image versionnée ; le
script refuse le chemin Compose sans vérification de release. Les droits sudo de
CI doivent être adaptés pour installer l’override et recharger systemd.

Références : [migration Vitest](https://v4.vitest.dev/guide/migration.html),
[redirections k6](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/),
[Gatling concurrence](https://docs.gatling.io/concepts/injection/),
[Gatling throttle et durée](https://docs.gatling.io/concepts/simulation/),
[Vegeta workers et redirections](https://github.com/tsenart/vegeta).
