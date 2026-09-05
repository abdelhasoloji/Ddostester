# Parcours d'utilisation

Pré-requis : service déployé, tunnel SSH ouvert, `http://localhost:8080` accessible.

## Test en circuit fermé (validation de la chaîne)

Sans configurer aucune cible externe, on peut valider tout le pipeline en visant
le service lui-même (`127.0.0.1`, déjà dans l'allowlist).

1. **Nouvelle campagne** :
   - Nom : `Autotest`
   - Auteur : ton identifiant
   - Cible : `http://127.0.0.1:8080/health`
   - Sonde : `http://127.0.0.1:8080/health`
   - Vecteur : `http-get`, Max RPS `20`, Concurrence `5`, Durée `30`
   - ☑ Attestation → **Soumettre**
2. **Approuver** (colonne Actions). _(en UI, l'approbateur par défaut est
   `officer@wedos` ; via l'API, il doit être différent de l'auteur.)_
3. **Exécuter** → le générateur et la sonde tournent 30 s.
4. **Rapport** → ouvre le HTML : WRS, latences, dispo, statut final.

## Campagne sur cible autorisée

1. Ajouter la cible à l'allowlist (voir [deployment.md](./deployment.md)) :
   ```bash
   ALLOWED_TARGETS="127.0.0.1,host-de-test.interne" bash deploy/setup.sh
   ```
2. Vérifier que la cible répond depuis le serveur :
   ```bash
   curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" http://host-de-test.interne/health
   ```
3. Créer la campagne avec cette cible, **en commençant prudemment** :
   `Max RPS 20`, `Concurrence 5`, `Durée 30 s`.
4. Approuver, exécuter, **surveiller la sonde** (latence, taux de 5xx).
5. Monter l'intensité **progressivement** seulement si l'environnement encaisse
   et dans la limite des plafonds (`maxRps ≤ 2000`, `durée ≤ 900 s`).

## Bonnes pratiques

- Toujours démarrer bas et augmenter par paliers.
- Garder un onglet sur les métriques de la cible en parallèle.
- Le **kill switch manuel** est là en cas de doute : `POST /api/campaigns/:id/kill`.
- Ne jamais viser une cible hors du périmètre mandaté (l'allowlist le garantit).

## Profils de charge (scénarios bornés — GEN-03)

Dans le formulaire, « Profil de charge » traduit Max RPS + durée en phases :

- **Constant** — débit unique (défaut).
- **Montée progressive** — 25 % → 50 % → 100 % du Max RPS sur trois tiers.
- **Vagues** — 100 % → 20 % → 100 %.

Chaque phase reste soumise aux plafonds (`maxRps ≤ 2000`, durée totale ≤ 900 s).
Aucun vecteur volumétrique : ce ne sont que des débits HTTP bornés modulés.

## Export PDF des rapports (RPT-01)

Chaque rapport (campagne et conformité) porte un bouton **« Imprimer / PDF »**
qui ouvre la boîte d'impression du navigateur → « Enregistrer en PDF ». Une
feuille de style d'impression masque les contrôles et met en page proprement,
sans dépendance serveur (pas de moteur headless à installer sur la cible).
