# Recette réelle des moteurs sur loopback

Le mode extended inclut aussi un cas à 0,5 RPS pendant 5 s, avec reçus espacés d'au moins 1 900 ms (intervalle nominal 2 s) et borne d'émission de 5 s + 1 s de tolérance. La configuration du résultat conserve les budgets par cas ; celle à la racine décrit les cas ordinaires. Réduire une fenêtre trop courte peut produire moins de trafic que demandé ; cela ne valide pas l'intensité de toutes les phases.

Depuis la racine, avec les dépendances installées :

```sh
npx tsx scripts/conformance/engines.ts builtin /private/tmp/builtin-proof-new.json
```

Remplacer `builtin` par `k6`, `vegeta`, `locust`, `jmeter` ou `gatling` pour utiliser l'adaptateur et son vrai binaire installé. Les variables `*_BIN` habituelles sont respectées. Aucun téléchargement ni installation automatique n'est effectué. Le fichier de sortie doit être nouveau ; il est créé exclusivement avec permissions 0600.

Pour Gatling 3.16.0, définir `GATLING_HOME` vers le bundle Maven vérifié et `JAVA_HOME` vers le JDK. Le mode moderne compile hors ligne puis attend que les utilisateurs natifs soient prêts, sans trafic cible. Cette préparation est bornée à 60 secondes et reste annulable. La recette exige zéro reçu pendant cette phase, puis applique les mêmes limites de durée, débit et concurrence à la phase de charge. `preparationMs` est conservé séparément du temps de charge. L'orchestrateur utilise le même contrat `prepare`, rafraîchit la baseline après préparation et arme ensuite le minuteur et la sonde de charge. Le chemin historique `GATLING_BIN` n'a pas cette validation moderne.

L'arrêt du mode Maven signale d'abord aux utilisateurs natifs de ne plus commencer de requêtes. Une seconde maximum permet de finaliser les réponses déjà en cours et de vider les mesures ; ensuite le groupe est forcé si nécessaire. Une réponse réellement finalisée pendant cette grâce conserve ses mesures ; une requête bloquée reste explicitement non finalisée, sans code HTTP ni latence fabriqués.

La cible est un serveur dédié créé par la recette sur `127.0.0.1`, port éphémère. Aucune URL externe n'est acceptée. Cinq scénarios séquentiels vérifient un GET lent, une redirection, une réponse HTTP 503, un timeout et l'annulation : 2 RPS, concurrence 2, durée configurée 3 secondes. Les reçus côté cible enregistrent le nombre de requêtes, les dates monotones et le pic de concurrence. Les assertions comprennent l'absence de suivi de redirection, un maximum de huit reçus par scénario (budget nominal six avec tolérance de démarrage), un délai de terminaison de dix secondes et aucune nouvelle requête après une seconde suivant l'annulation. Les compteurs doivent rester cohérents ; hors annulation, le nombre rapporté doit correspondre aux reçus. Les scénarios 503 et timeout doivent rapporter des échecs sans succès. Ce seuil de recette ne remplace pas les limites du produit.

Le mode `extended`, ajouté comme troisième argument après le fichier de preuve, ajoute un flow de trois GET avec pause de 2 s après chaque étape (1 RPS / 3 s) et deux phases courtes (1 RPS pendant 1 s, puis 2 RPS pendant 2 s). Il vérifie aussi l'absence de requêtes au-delà du budget de 3 s augmenté d'une seconde de tolérance de démarrage/observation. Un moteur qui ne prend pas en charge une capacité conserve son état unsupported/not-validated ; il n'est pas validé sur ce scénario.

L'arrêt dur peut interrompre une tentative avant son émission ou avant sa réponse. Quand l'adaptateur fournit `finalizedRequests` et `unfinalizedRequests`, la recette exige l'égalité total=finalized+unfinalized et des reçus cible compris entre finalized et total. Elle ne force pas l'égalité entre tentatives commencées et requêtes reçues. Une issue non finalisée n'est jamais inventée comme un statut HTTP. Pour les anciens adaptateurs dépourvus de cette distinction, l'assertion d'égalité des reçus reste utilisée hors annulation. Les 302, 503 et timeouts ne doivent produire aucun succès.

Un échec d'assertion produit un code de sortie 1 et conserve le détail. Un binaire absent produit un état `unavailable` / `not-validated` ; son code de sortie 0 indique uniquement que l'inventaire a terminé. Il ne prouve aucune conformité du moteur. Le résultat brut de l'adaptateur et les reçus sont conservés ensemble, sans les assimiler à un rapport de campagne finalisé.

Cette recette ne couvre pas encore la corrélation réelle, les graines IoT exécutées par un outil externe, les erreurs de processus, les captures de paquets ni tous les environnements. Les deux cas étendus ne prouvent pas la conformité complète des flows/phases ou un plafond de débit instantané. Pour une promotion, relever les versions exactes et références source/image séparément, compléter le corpus et confronter les résultats aux caps réelles. Ne pas présenter le succès d'un moteur comme une validation des autres.

Depuis la recette Locust 04, le cas stop attend le premier reçu cible puis annule 150 ms après, pendant la réponse lente ; une garde de démarrage à 2,5 s reste dans le budget original de 3 s. Le contrôle exige une requête active au moment de l’annulation. Les anciennes recettes à délai fixe ne sont pas réécrites. Les autres moteurs doivent repasser ce cas modifié avant comparaison du corpus commun.
