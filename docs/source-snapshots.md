# Identifier les sources sans modifier les travaux locaux

`scripts/operations/source-snapshot.py` crée une archive privée des fichiers suivis par Git et des fichiers non ignorés du checkout. Il conserve HEAD comme référence historique, sans faire de commit, modifier l’index ni changer de branche. Les liens symboliques, fichiers disparus et `.DS_Store` sont exclus et listés dans le manifeste. Les dépendances/builds ignorés et le répertoire Git ne sont pas archivés.

Depuis le dépôt, choisir un répertoire existant privé (0700) hors checkout et un nom nouveau :

```sh
python3 scripts/operations/source-snapshot.py /chemin/prive/source-001.tar.gz
python3 scripts/operations/verify-source-snapshot.py /chemin/prive/source-001.tar.gz
```

L’archive et son reçu `.json` sont créés exclusivement, mode 0600. Le manifeste `ddostester-source-manifest.json` inclus porte chaque chemin, taille, mode normalisé et SHA-256. Le reçu porte le checksum du manifeste et celui de l’archive, la taille, le nombre de fichiers et HEAD. Le script refuse une modification de taille/mtime pendant la capture, un changement de HEAD ou d’inventaire Git, un fichier de plus de 16 Mio et un total de plus de 256 Mio.

Les métadonnées tar/gzip sont normalisées : à sources, modes et exclusions identiques, les archives sont identiques. Le manifeste doit être vérifié après transfert, avant extraction/build ; utiliser le filtre data lors de l’extraction Python. Conserver reçu et archive avec le bilan de validation de cette version. Les sources peuvent contenir des données privées : ne pas publier l’archive sans revue.

Cette capture identifie précisément un checkout dirty pour une recette de laboratoire. Elle ne remplace pas la revue, les commits/PR, le gate de CI ou la promotion vérifiée nécessaires à une release produit. Le SHA-256 détecte une altération par rapport à un reçu fiable ; il n’authentifie pas l’auteur de l’archive. Un snapshot dont la capture précède une modification ne contient pas cette modification.
