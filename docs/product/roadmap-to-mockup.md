# Feuille de route — de l'état actuel à la maquette

Référence : `docs/product/mockup/drs-app.html`. Sept écrans à atteindre, dans cet ordre.
Chaque phase est un ou plusieurs incréments fusionnés et déployés, avec une entrée de journal.

## État de départ (constaté)

| Brique             | Aujourd'hui                                                             |
| ------------------ | ----------------------------------------------------------------------- |
| Client             | un champ texte sur la campagne, pas d'entité                            |
| Formulaire de plan | un seul formulaire dans Capacity, pas d'assistant                       |
| Mode synthétique   | `drsMode: 'synthetic-lab'` existe dans le domaine, non exposé dans l'UI |
| Assessment         | détail inline sur la page Assessments, pas d'écran dédié                |
| Comparaison        | panneau inline, pas de route                                            |
| Livrables          | PDF et JSON, pas de bundle                                              |
| Garde-fous         | dans le code et les variables d'environnement, pas d'écran              |

## Phase 1 — Le dossier client (fondation)

**Pourquoi d'abord** : l'assistant commence par « client & cible » ; sans entité client, l'étape
n'a rien à sélectionner et le dossier reste une étiquette.

- Table `drs_clients` : id, nom, contacts, scope signé (référence, date, cibles, plafond rps),
  état, horodatages. Migration 10, store mémoire et PostgreSQL, audit.
- `GET/POST /api/drs/clients`, `GET/PATCH /api/drs/clients/:id`.
- `clientId` sur la campagne ; `client` (nom) conservé pour les campagnes existantes, migré en
  douceur à la première lecture.
- Écran **Clients** : la liste devient celle des entités, avec compteurs et dernier verdict.
- Écran **Dossier client** : scope, cibles autorisées, campagnes, exigences restantes.

**Acceptation** : créer un client avec deux cibles, y rattacher une campagne, voir le dossier
afficher le tout ; une campagne sans client reste lisible.

## Phase 2 — L'assistant de campagne (4 étapes)

- Étape 1 : client (liste) + cible (restreinte au scope du client **et** à l'allowlist).
- Étape 2 : **mode** — campagne complète (mesurée) ou amplificateur synthétique. Le choix est
  enregistré dans le plan (`mode`) et affiché partout ensuite.
- Étape 3 : niveau, exposition, baseline, débit, assertion, justification, avec l'enveloppe
  calculée en direct et les budgets plafonnés.
- Étape 4 : récapitulatif, attestation d'autorisation, gel du plan (hash affiché).
- Remplace le formulaire unique de Capacity ; Capacity garde la calibration et la reachability.

**Acceptation** : créer une campagne mesurée puis une campagne synthétique sans quitter
l'assistant ; le plan gelé porte le mode et l'enveloppe ; la cible hors scope est refusée.

## Phase 3 — L'amplificateur synthétique (exécution + écran)

- Exécution synthétique : le moteur produit la charge **annoncée** sans viser la cible (ou vers
  une cible de laboratoire dédiée), mesure la fidélité (débit et concurrence réellement produits
  vs annoncés), vérifie l'intégrité du plan et les exclusions, scelle une validation moteur.
- État de révision `ENGINE_VALIDATED`, aucun verdict de niveau, `certification: false` explicite.
- Écran **Assessment synthétique** : ce que la campagne établit / ce qu'elle n'établit pas, en
  deux tableaux de même poids ; fidélité chiffrée ; PDF portant la mention **SYNTHETIC — NON
  CERTIFIANT**.

**Acceptation** : lancer une campagne synthétique depuis l'assistant, obtenir une révision
`ENGINE_VALIDATED` avec fidélité mesurée, et un PDF qui ne ressemble pas à un rapport de test réel.

## Phase 4 — L'écran d'assessment mesuré

- Route `/assessments/:campaignId` : frise d'états, verdict, points d'observation (generator,
  user, entry, origin) avec charge observée et empreintes, exigences archivées, livrables.
- La page Assessments devient une liste avec lien vers l'écran.
- Les actions Replay, Compare, Cancel y sont regroupées.

**Acceptation** : une campagne mesurée existante s'ouvre sur son écran, avec ses quatre points
d'observation et ses exigences, sans passer par une ligne dépliée.

## Phase 5 — La comparaison en écran

- Route `/assessments/:id/compare/:with`.
- Sélection de deux campagnes finalisées depuis le dossier client ou la liste.
- Reprise de `compareDrsReports` et de la route existante.

**Acceptation** : comparer deux révisions et lire une phrase de conclusion, pas seulement des
chiffres.

## Phase 6 — Livrables et garde-fous

- Bundle de preuve (zip) : PDF, JSON, empreintes, paramètres d'enveloppe. `GET
/api/campaigns/:id/drs/bundle`.
- Écran **Autorisation & plafonds** : caps, plafond de service, plancher de baseline, allowlist,
  état du kill switch, témoins configurés.
- Témoins portés **sur le plan** (client) plutôt que globalement au déploiement.

**Acceptation** : télécharger un bundle et y retrouver les mêmes empreintes que le rapport ;
lire les garde-fous sans ouvrir un fichier de configuration.

## Phase 7 — Finition

- Navigation DRS only, états vides, libellés cohérents, pages d'erreur.
- Parcours complet rejoué dans Chrome sur la recette, captures à l'appui.

**Acceptation** : les sept écrans de la maquette existent et se tiennent, testés dans le
navigateur sur `testdrs.trustena.lu`.

## Règles tenues pendant toute la traversée

- Aucune régression sur les campagnes legacy (343 en production) : les nouvelles entités sont
  additives.
- Autorisation, allowlist, kill switch et audit restent en place à chaque étape.
- Un verdict ne devient jamais une certification ; le mode synthétique ne produit aucun verdict.
- Chaque incrément : branche, PR, CI verte, fusion, déploiement, entrée de journal.
