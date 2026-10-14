# Récupération administrative du propriétaire

Cette procédure traite la perte du mot de passe du propriétaire persisté. Elle ne transfère pas la propriété et ne crée aucun compte. La base doit déjà contenir la politique du propriétaire unique et son compte admin. Une incohérence de politique ou un second admin entraîne un refus ; investiguer séparément plutôt que modifier collectivement les profils.

1. Préparer une sauvegarde chiffrée vérifiée et un identifiant d’intervention (`OPS-123`). Arrêter le service applicatif et désactiver temporairement son redémarrage automatique pendant l’intervention. La commande exige le verrou PostgreSQL du runtime ; elle refuse si un autre contrôle le détient.
2. Sur l’hôte administratif, créer un fichier régulier privé, appartenant à l’utilisateur exécutant la commande, mode 0600 ou 0400, contenant uniquement un nouveau mot de passe temporaire conforme à la politique. Ne pas placer ce mot de passe dans les arguments, l’historique shell, Git, les logs ou un ticket. Les liens symboliques et fichiers de plus de 4096 octets sont refusés.
3. Utiliser les sources/release identifiées contenant `backend/dist/cli/recover-owner.js`, avec `DATABASE_URL` chargé depuis la configuration protégée habituelle, sans imprimer la configuration. Depuis la racine de la release :

   ```sh
   node backend/dist/cli/recover-owner.js /chemin/prive/mot-de-passe OPS-123
   ```

4. Vérifier le résultat sans secret : `recovered`, `sessionsRevoked` et `temporaryPassword` valent true. La mutation et l’événement `user.owner.recovered` sont transactionnels. Le compteur de session augmente, le compte est actif, le changement du mot de passe au prochain login est obligatoire. Les autres utilisateurs restent inchangés. Une panne d’audit annule la mutation.
5. Supprimer le fichier temporaire, rétablir le service, puis se connecter en propriétaire pour choisir un nouveau mot de passe. Vérifier le refus de l’ancien token et la chaîne d’audit. Documenter seulement l’identifiant d’intervention et le résultat.

Le matériel secret de `AUTH_USERS` n’est pas modifié. Cette procédure concerne les comptes migrés vers le store avec politique persistée ; elle refuse la récupération d’une installation legacy sans cette politique. Une compromission complète de l’hôte/DB nécessite aussi la rotation des secrets de signature et identités, selon le runbook d’incident.

Validation : tests mémoire (récupération ciblée, rollback si audit indisponible, refus du second admin) et test PostgreSQL sur base temporaire distincte (verrou exclusif, récupération et chaîne). La recette n’exécute aucun reset sur les comptes de production.
