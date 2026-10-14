# Audit du user management et proposition de refonte

Date : 13 octobre 2026. Périmètre : checkout local Ddostester et installation VPS existante, audit en lecture seule. Aucune modification de compte, campagne, installation ou déploiement réalisée pendant cet audit.

## Résultat principal

Le compte `abdelha@wedos` est bien actif et porte le rôle `admin` sur le VPS. Le problème est la définition des permissions chargées, puis l'écart entre le code local et le code déployé. La promotion de ce compte n'a pas rendu disponible le parcours complet promis : les nouvelles permissions n'ont pas été déployées.

Le VPS répond avec la version 0.2.0, build 449, commit `d98db08`. Sa configuration contient `USER_MODE=single`, `SINGLE_USER_EMAIL=abdelha@wedos`, `SCHEDULER=off`. Pourtant `/health` ne rapporte aucun `userMode`, et `backend/dist/auth/single-user.js` est absent. La version courante ignore donc la nouvelle option. Le frontend local utilise aussi `team` comme fallback lorsque `/health` ne fournit pas le mode.

## Vérifications sur l'installation réelle

Lecture du module RBAC effectivement déployé, puis requêtes GET authentifiées de diagnostic avec un jeton court conservé seulement en mémoire serveur. Aucun mot de passe, hash de mot de passe ou secret affiché.

| Fonction                        | Permission admin chargée sur le VPS |
| ------------------------------- | ----------------------------------- |
| Consulter campagnes et rapports | Accordée                            |
| Créer une campagne              | Refusée                             |
| Approuver une campagne          | Refusée                             |
| Exécuter une campagne           | Refusée                             |
| Arrêter une campagne            | Accordée                            |
| Gérer utilisateurs et limites   | Accordée                            |
| Enregistrer une cible           | Accordée                            |
| Autoriser une cible             | Refusée                             |
| Lire le catalogue bench         | Refusée                             |
| Administrer l'assistant         | Accordée                            |

Constats HTTP : `/api/auth/me` retourne 200, identité admin, aucun changement forcé de mot de passe ; `/api/users`, `/api/limits`, `/api/campaigns`, `/api/targets`, `/api/assistant/status` retournent 200 ; `/api/bench/scenarios` retourne 403 avec `missing bench:read permission`.

Les refus création/approbation/exécution sont établis par la matrice RBAC chargée. Aucun POST de campagne ou de lancement n'a été envoyé pour les tester. L'admin dispose donc de droits d'administration, tandis que son accès au parcours de campagne est limité à la consultation et à l'arrêt. Si les réglages paraissent également en lecture seule dans le navigateur, il faut vérifier séparément la session et le bundle UI servis ; cet audit n'a pas observé la session navigateur de l'utilisateur.

## Constats sur le code local préparé

Sources examinées : `auth/{rbac,guard,users,jwt,password-policy}.ts`, `auth/single-user.ts`, routes auth/users/campagnes de `app.ts`, `modules/users/service.ts`, `modules/campaigns/service.ts`, routes cibles, stores, `server.ts`, `frontend/src/api.ts`, `frontend/src/{context,ui,pages,settings-cards,assistant-action-card}.tsx`, tests RBAC/single-user et scripts de déploiement.

1. **Permissions dépendantes du mode.** `can()` et `canDo()` donnent tous les droits à admin seulement en single. La matrice team conserve un admin sans création/approbation/exécution. Le libellé « Administrator » ne permet pas de prévoir les droits réels.
2. **Gestion des comptes bloquée en single.** La carte Users est remplacée par My account et un hook rejette toutes les écritures `/api/users`. Cela empêche l'admin de gérer les autres profils depuis l'application.
3. **Désactivation automatique des autres comptes.** `prepareSingleUser()` désactive tous les autres comptes et rétrograde les autres admins en viewer. Garder un seul admin avec d'autres profils utilisables nécessite une autre politique de comptes.
4. **Deux définitions des permissions.** La matrice backend et son miroir frontend sont maintenus séparément. Le test frontend compare à une table attendue locale ; il ne garantit pas à lui seul l'accord avec les capacités de l'API déployée.
5. **Deux sources d'identité.** Les comptes `AUTH_USERS` et PostgreSQL ont des comportements différents. En team, les env roots ne sont ni modifiables via UI ni soumis au même contrôle de version de session ; le résolveur utilise notamment leur rôle porté par le JWT. Une refonte doit supprimer cette différence pour les comptes courants.
6. **Invariants de comptes incomplets.** Les gardes préservent au moins un admin actif, mais n'imposent pas un propriétaire admin unique en team. Les contrôles de nombre d'admins et les mises à jour sont séparés, ce qui demande une protection transactionnelle contre les requêtes concurrentes.
7. **Migration mêlée au démarrage.** La préparation de single modifie les comptes au boot. Le lot de comptes est transactionnel, mais son audit est écrit ensuite. Certaines mutations de compte écrivent au contraire un audit avant la sauvegarde effective. Il faut distinguer migration explicite, fonctionnement normal et résultat réellement enregistré.
8. **Validation insuffisante du déploiement.** Les tests locaux ont validé le code préparé ; ils n'ont pas validé que cette version, cette politique et ce frontend étaient chargés sur le VPS. Un `/health` à 200 ne prouve pas que les fonctionnalités attendues existent. `deploy/setup.sh` n'écrit pas les nouvelles options de mode dans son envfile généré.
9. **Durcissement des sessions à compléter.** Les mots de passe, changements forcés et versions de session sont déjà présents. Compléter la validation stricte des claims JWT, le bornage de la protection anti-brute-force en mémoire, les sessions visibles/révocables et le rafraîchissement de l'identité UI après un refus 401. Évaluer ensuite cookies sécurisés et tickets courts de rapports, au lieu de placer le jeton de session dans les URL d'export.

## Modèle recommandé : administrateur unique avec profils gérés

Pour cette installation, proposer `abdelha@wedos` comme propriétaire et seul admin. Les autres profils restent gérables ; leur activation est une décision explicite de l'admin. Un profil viewer peut consulter, sans lancer ni approuver. Les comptes déjà désactivés ne sont pas réactivés automatiquement.

| Profil               | Fonction proposée                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| admin / propriétaire | Toutes les fonctions : utilisateurs, cibles, campagnes, exécution, arrêt, rapports, limites et assistant  |
| engineer             | Préparer et lancer les campagnes selon la politique configurée ; aucun droit d'administration des comptes |
| ciso                 | Valider et consulter selon la politique configurée ; aucun droit d'administration des comptes             |
| viewer               | Consultation uniquement                                                                                   |

Séparer trois décisions dans le modèle : identité du propriétaire (`primaryAdminId`), capacités du profil et politique de lancement. Le mode strict avec un seul compte connecté peut rester disponible, mais ne doit pas être la condition permettant à admin d'avoir ses droits complets.

Politique recommandée pour l'usage personnel/lab : confirmation explicite du lancement après affichage de la cible, des plafonds et de la durée. Politique équipe : contrôle distinct des décisions et respect de la séparation des responsabilités, y compris lorsque l'admin possède toutes les capacités. Les permissions permettent une opération ; la politique détermine les conditions de cette opération. Conserver allowlist, attestation, plafonds immuables, arrêt et audit dans les deux cas. Scheduler off par défaut pour le parcours personnel.

## Contrat d'autorisation

Un registre de permissions côté backend calcule les capacités effectives et les conditions du workflow. `/api/auth/me` retourne identité, statut, rôle, liste des capacités, politique de lancement et version du contrat. Le frontend affiche les actions à partir de cette réponse ; il ne recalcule pas une matrice parallèle. Chaque mutation continue à être contrôlée par l'API.

Le propriétaire est enregistré comme donnée de configuration persistée ; l'adresse email sert à le sélectionner lors de la migration, sans être dispersée dans la logique métier. Refuser la création d'un deuxième admin, la rétrogradation, suppression ou désactivation du propriétaire via les routes ordinaires. Prévoir un transfert de propriété et une récupération explicites, audités et vérifiables.

## User management à compléter

- Écran **Users & access** : comptes, rôle, statut, dernière connexion, besoin de changement de mot de passe ; filtre comptes actifs/désactivés et explication des capacités.
- Création de comptes non-admin, changement de profil, désactivation/réactivation et reset avec mot de passe temporaire ; aucune suppression de l'historique.
- **My account** pour le propriétaire et les autres comptes : changement de mot de passe et gestion/révocation des sessions.
- PostgreSQL comme source unique des comptes courants ; AUTH_USERS limité à un import initial contrôlé, avec suppression de son rôle de root permanent après migration.
- Transactions pour modifications de rôle/statut, révocation et trace d'audit. Version de session incrémentée atomiquement ; gestion des conflits concurrentiels.
- Conservation du hash de mot de passe existant, des identifiants, campagnes, rapports et auteurs historiques. Aucun reset collectif de mots de passe.

## Ordre de réalisation proposé

1. Fixer la matrice et la politique : admin complet, propriétaire unique, statut souhaité des autres comptes, confirmation personnelle par défaut.
2. Centraliser les capacités ; revoir tous les parcours (campagne simple, suites, assistant, cibles, limites, comptes et rapports).
3. Compléter les écrans et les routes des comptes, le rafraîchissement d'identité et les erreurs d'autorisation explicites.
4. Remplacer la mutation automatique des utilisateurs à chaque boot par une migration explicite, versionnée, avec aperçu des changements et sauvegarde. Importer les comptes env une seule fois.
5. Tester backend et frontend ensemble, avec refus des autres profils et parcours admin complet. Tester concurrence, redémarrage, mot de passe inchangé et sessions révoquées.
6. Préparer un déploiement cohérent backend/UI, sauvegarde, rollback et contrôle du commit chargé. Activer d'abord sans lancer de campagne. Vérifier `/api/auth/me`, contrat de capacités, `/health` et actions visibles avec une vraie session admin.
7. Valider l'exécution ensuite dans une cible dédiée du laboratoire, avec moteur simulé pendant les tests d'autorisation et aucune campagne réelle sur les cibles actuelles du VPS dans cette phase.

## Critères d'acceptation

- `abdelha@wedos` est seul admin et peut utiliser toutes les fonctions de l'interface ; un viewer ne peut ni changer la configuration ni lancer une campagne par API.
- Les autres profils sont affichés et gérables ; statut conservé sauf décision explicite. Aucun second admin possible, même avec deux requêtes concurrentes.
- Une campagne ou suite ne démarre qu'après la décision imposée par la politique ; l'assistant ne contourne pas ce parcours.
- Changement de profil, désactivation, reset ou révocation de session prend effet dans l'API, les rapports et l'interface ; le mot de passe du propriétaire est conservé durant la migration.
- Version serveur/UI, politique et capacités sont vérifiées sur le VPS ; l'absence d'un contrat attendu bloque l'annonce d'une migration réussie.

Cette proposition nécessite une refonte supplémentaire : déployer simplement le mode single local actuel laisserait la gestion des autres comptes bloquée et les désactiverait au démarrage. Aucun déploiement ni nouvelle modification de compte n'a été effectué pendant cet audit.
