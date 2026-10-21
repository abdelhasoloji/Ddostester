# Roadmap — refonte de l'interface DRS

Objectif : livrer l'interface décrite dans `mockup.html`, en **réutilisant le backend existant**
(les routes et modèles DRS sont déjà en place) et en reconstruisant la couche de présentation.

Références : `benchmark.md` (marché), `ia.md` (arborescence, cas d'usage, correspondance API),
`mockup.html` (maquette navigable).

## Principes

1. **Aucun backend réécrit.** On ajoute au plus trois agrégats de lecture ; tout le reste est déjà
   exposé (`/api/drs/*`, `/api/campaigns`, rapports, bundle).
2. **Une PR par écran**, chacune vérifiée dans Chrome sur la recette avant la suivante.
3. **Composants partagés d'abord** : chips, cartes, onglets, barres, états vides. Sans ça, chaque
   écran réinvente son style — c'est ce qui a produit l'interface actuelle.
4. **Le vocabulaire interne ne sort pas** : `PLAN_FROZEN` devient « Plan gelé », `LEVEL_EXECUTION`
   devient « En cours », `ENGINE_VALIDATED` devient « Instrument validé ».
5. **Chaque écran a un état vide utile** et une action primaire unique.

## Ce qui existe déjà et ne bouge pas

| Brique backend                  | Route                                         |
| ------------------------------- | --------------------------------------------- |
| Enveloppe, agents, reachability | `GET /api/drs/capacity`                       |
| Calibration                     | `POST /api/drs/calibrations`                  |
| Dossiers clients                | `GET/POST /api/drs/clients`, `GET/PATCH /:id` |
| Plans                           | `POST /api/drs/plans`                         |
| Exécution, arrêt, rejeu         | `POST /:id/drs/execute`, `/cancel`, `/replay` |
| Document de campagne            | `GET /api/campaigns/:id/drs`                  |
| Rapports                        | `GET /:id/drs/report.json`, `/report.html`    |
| Bundle                          | `GET /:id/drs/bundle`                         |
| Comparaison                     | `GET /:id/drs/compare?with=`                  |
| Garde-fous                      | `GET /api/drs/guardrails`                     |
| Audit                           | `GET /api/audit`                              |

## À ajouter côté backend (trois agrégats de lecture)

1. `GET /api/drs/overview` — posture : nombre d'exigences atteintes/total, couverture par niveau,
   campagne en cours, éléments « à traiter », derniers verdicts. Compose les données existantes.
2. `GET /api/drs/reports` — index des rapports (client, campagne, mode, verdict, date) avec lien
   vers PDF/JSON/bundle ; filtrable par client.
3. `GET /api/drs/audit` (ou réutilisation de `/api/audit`) filtré sur les actions DRS, projeté en
   lignes lisibles (qui, quand, objet, détail).

## Phase A — Socle d'interface (0,5 j)

- Rail à trois groupes (Pilotage, Clients, Plateforme), barre supérieure avec contexte client,
  recherche, bouton primaire « New campaign ».
- Bibliothèque de composants : `Chip`, `Card`, `KPI`, `Bar`, `Tabs`, `EmptyState`, `Confirm`.
- Table de correspondance des états internes → libellés.
- **Acceptation** : les pages existantes (Clients, Capacity, Assessments) s'affichent dans le
  nouveau cadre, sans régression fonctionnelle.

## Phase B — Overview (1 j)

- `GET /api/drs/overview` + écran : note de posture, couverture par niveau, panneau direct,
  « à traiter », derniers verdicts, bandeau capacité.
- Panneau direct : avancement, débit observé, points d'observation, **kill switch toujours visible**
  (réutilise `POST /:id/drs/cancel`).
- **Acceptation** : pendant une campagne réelle sur la recette, le panneau se met à jour et l'arrêt
  finalise la campagne avec ce qui a été mesuré.

## Phase C — Campaigns (1,5 j)

- Liste filtrable (client, mode, état, période) — filtrage côté client dans un premier temps, le
  volume actuel le permet.
- Écran campagne avec **onglets** : Progression, Preuve, Exigences, Rapports. Reprend
  `GET /:id/drs` (document, trace, preuve) et `report.json`.
- Actions : arrêter, relancer (`/replay`), comparer, rapport.
- **Acceptation** : une campagne mesurée s'ouvre sur ses quatre onglets, une campagne synthétique
  affiche sa validation et **aucun verdict**.

## Phase D — Rapports (1 j)

- `GET /api/drs/reports` + écran bibliothèque (client, campagne, mode, verdict, date, actions).
- Aperçu du rapport (résumé exécutif, verdict, écarts, mention non certifiante) et téléchargements.
- **Acceptation** : le PDF et le bundle téléchargés depuis cet écran sont identiques à ceux servis
  par l'API.

## Phase E — Clients (1 j)

- Grille de dossiers avec couverture et dernier verdict ; état vide « créer un dossier ».
- Dossier : scope signé, contacts, campagnes, rapports, bouton « nouvelle campagne ».
- **Acceptation** : créer un client puis une campagne depuis son dossier, cible imposée par le scope.

## Phase F — Capacity et Settings (1 j)

- Capacity : enveloppe, agents (avec alerte d'expiration), niveaux atteignables, calibration.
- Settings : limites appliquées, témoins, allowlist, journal d'audit lisible.
- **Acceptation** : les valeurs affichées correspondent à `/api/drs/guardrails` et aux agents
  calibrés ; aucune valeur codée en dur dans l'écran.

## Phase G — Finition (1 j)

- États vides sur les huit écrans, confirmations destructives, cohérence des chips.
- Parcours complet rejoué dans Chrome : client → campagne → direct → arrêt → verdict → rapport →
  comparaison.
- **Acceptation** : zéro erreur console, aucune table technique exposée sans libellé métier.

## Estimation et ordre

| Phase                 | Effort | Dépend de     |
| --------------------- | ------ | ------------- |
| A · Socle             | 0,5 j  | —             |
| B · Overview          | 1 j    | A, `overview` |
| C · Campaigns         | 1,5 j  | A             |
| D · Rapports          | 1 j    | A, `reports`  |
| E · Clients           | 1 j    | A             |
| F · Capacity/Settings | 1 j    | A             |
| G · Finition          | 1 j    | B→F           |

Total : **7 jours** de travail effectif, livrables en incréments fusionnés et déployés.

## Risques

| Risque                                                       | Mitigation                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Le panneau direct dépend de la fréquence de rafraîchissement | interroger `GET /:id/drs` toutes les 3 s seulement pendant l'exécution         |
| `overview` agrège beaucoup de campagnes                      | limiter aux 30 derniers jours et aux campagnes DRS                             |
| Divergence entre maquette et composants réels                | la phase A crée les composants, les phases suivantes ne font que les assembler |
| Régression sur les campagnes legacy                          | les nouveaux écrans lisent les mêmes routes ; aucune migration de données      |

## Ce qu'on ne fait pas dans cette refonte

- Pas de refonte du modèle de données : le dossier client, le plan, la preuve restent tels quels.
- Pas de nouvelle fonctionnalité DRS (pas de témoins supplémentaires, pas de niveaux supérieurs) :
  uniquement la présentation.
- Pas de thème sombre ni de personnalisation : le produit doit d'abord être lisible.
