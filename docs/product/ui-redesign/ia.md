# Architecture de l'information — refonte de l'interface DRS

Objectif : passer d'une **console d'administration** à un **produit de service** — un client, un
périmètre, un test, un verdict, un rapport. L'opérateur doit voir en un écran ce qui est protégé,
ce qui tourne, et ce qui demande une action.

## Personas et tâches

| Persona                      | Question à laquelle il vient répondre                       | Écran d'entrée               |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------- |
| **Opérateur DRS**            | « Qu'est-ce qui tourne, et qu'est-ce que je dois faire ? »  | Overview                     |
| **Responsable de compte**    | « Où en est le client X, et qu'est-ce que je lui envoie ? » | Clients → dossier → rapports |
| **Client (lecture)**         | « Suis-je protégé, et de quoi ? »                           | Rapport PDF/HTML partagé     |
| **Référent sécurité client** | « Qu'est-ce qui n'a pas été atteint, et pourquoi ? »        | Rapport → écarts             |
| **Admin / RSSI**             | « Qui a autorisé quoi, et dans quelles limites ? »          | Settings → audit, limites    |

## Arborescence

```
/                                 Overview ................ posture, direct, à traiter
/campaigns                        Campaigns ............... liste filtrable + états
/campaigns/new                    Nouvelle campagne ....... assistant 4 étapes
/campaigns/:id                    Campagne ................ direct, preuve, écarts, rapports
/campaigns/:id/compare/:with      Comparaison ............. avant / après
/clients                          Clients ................. dossiers, couverture, dernier verdict
/clients/:id                      Dossier client .......... scope signé, contacts, campagnes, rapports
/reports                          Rapports ................ bibliothèque client-ready
/reports/:campaignId              Rapport ................. vue lisible + PDF/JSON/bundle
/capacity                         Capacité ................ agents calibrés, enveloppe, niveaux
/settings                         Réglages ................ limites, témoins, allowlist, audit
```

Règle de navigation : **six entrées maximum** dans la barre latérale, groupées en trois blocs.

```
PILOTAGE      Overview · Campaigns
CLIENTS       Clients · Reports
PLATEFORME    Capacity · Settings
```

## Écrans, rôles et contenu

### 1. Overview — « suis-je protégé ? »

- **Bandeau posture** : note globale (ex. 42 / 100) + couverture par niveau DRS (1 → 7) en barres
  rouge/ambre/vert, avec le nombre d'exigences atteintes.
- **Direct** : la campagne en cours (client, cible, niveau, avancement, débit observé, temps
  restant) avec un **bouton d'arrêt toujours visible**.
- **À traiter** : liste courte et actionnable — témoin manquant, calibration expirée, verdict
  `INDETERMINATE`, exigence non atteinte récurrente.
- **Derniers verdicts** : 5 lignes, verdict + client + date + lien.
- **Capacité** : enveloppe et agents admis, avec un lien vers Capacity.

### 2. Campaigns — « qu'est-ce qui tourne ? »

- Filtres : client, mode (mesuré / synthétique), état, période.
- Colonnes : campagne, client, mode, niveau, état (chip), verdict, durée, actions.
- Actions rapides : ouvrir, comparer, relancer, arrêter.
- État vide : « Aucune campagne pour ce filtre » + bouton de création.

### 3. Campagne (détail) — le cœur du produit

Onglets, pour ne pas empiler quatre vérités sur un seul écran :

| Onglet          | Contenu                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Progression** | frise d'états, direct si en cours, kill switch, journal des transitions                          |
| **Preuve**      | points d'observation (générateur, utilisateur, bord, origine) avec charge observée et empreintes |
| **Exigences**   | requis / enregistré / atteint par vecteur et dimension, avec la raison du manque                 |
| **Rapports**    | aperçu du rapport client, PDF, JSON, bundle                                                      |

### 4. Nouvelle campagne — assistant qui empêche les erreurs

Quatre étapes, avec un **rail de résumé** permanent à droite (client, cible, mode, enveloppe,
témoins, autorisation). L'étape 3 refuse une cible hors du scope signé ; l'étape 4 exige
l'attestation.

### 5. Clients — « où en est ce client ? »

- Cartes ou lignes : nom, scope, cibles, dernières campagnes, verdict, couverture.
- Dossier : scope signé + contacts + campagnes + rapports + bouton « nouvelle campagne ».
- État vide : créer un dossier avec scope (référence, date, cibles, plafond).

### 6. Rapports — le livrable

- Liste : client, campagne, verdict, mode, date, action (ouvrir / PDF / bundle).
- Vue rapport : résumé exécutif, verdict, écarts, preuves, mentions légales et non-certification.
- Le PDF est le même contenu, imprimable.

### 7. Capacity — « de quoi dispose-t-on ? »

- Enveloppe calculée, agents calibrés (débit, concurrence, conditions, expiration).
- Niveaux atteignables avec la raison exacte du manque.
- Calibration d'un agent.

### 8. Settings — les limites et la traçabilité

- Plafonds (matériels, service), plancher de baseline, allowlist, témoins, kill switch.
- **Journal d'audit lisible** : qui, quand, quoi, sur quel objet.

## Cas d'utilisation (parcours)

**UC1 — Première campagne d'un nouveau client.** Créer le dossier (scope, contacts) → nouvelle
campagne → cible imposée par le scope → mode mesuré → niveau et exposition → attestation → gel.
_Attendu : la cible hors scope est impossible à sélectionner._

**UC2 — Test en cours sous surveillance.** Overview → panneau direct → si dérive, **arrêt** →
la campagne se finalise avec ce qui a été mesuré → verdict partiel assumé.

**UC3 — Le client demande son rapport.** Clients → dossier → onglet Rapports → PDF ou bundle.

**UC4 — Après un changement de protection.** Campaigns → filtrer le client → comparer deux
campagnes → phrase de conclusion → envoyer le delta.

**UC5 — Le client fournit une télémétrie.** Nouvelle campagne → étape 3 → saisir les URLs de
témoin (validées, adresses privées refusées) → l'écran de preuve montre bord et origine.

**UC6 — Valider la chaîne de mesure sans toucher la cible.** Nouvelle campagne → mode synthétique
→ exécution → écran de validation avec fidélité ; aucun verdict n'est rendu.

**UC7 — Un auditeur demande qui a autorisé.** Settings → audit → filtrer sur la campagne →
lignes horodatées.

## Correspondance avec le backend existant

| Écran     | Réutilise                                                           | Manque à créer                                           |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| Overview  | `/api/drs/capacity`, `/api/campaigns`, `/api/drs/clients`           | agrégat posture (note + couverture), liste « à traiter » |
| Campaigns | `GET /api/campaigns`, `POST /:id/drs/execute`, `/cancel`, `/replay` | filtres serveur (client, mode, état)                     |
| Campagne  | `GET /api/campaigns/:id/drs`, `/report.json`, `/bundle`             | rien de bloquant ; progression déjà dans le document     |
| Assistant | `POST /api/drs/plans`, `/clients/:id`                               | —                                                        |
| Clients   | `/api/drs/clients[/:id]`                                            | couverture par client                                    |
| Rapports  | `/report.html`, `/report.json`, `/bundle`                           | index des rapports (`GET /api/drs/reports`)              |
| Capacity  | `/api/drs/capacity`, `POST /calibrations`                           | —                                                        |
| Settings  | `/api/drs/guardrails`, audit                                        | —                                                        |

## Principes d'ergonomie retenus

1. **Un écran = une question.** Sinon on empile des tables.
2. **L'action principale est toujours au même endroit** : bouton primaire en haut à droite.
3. **Chips d'état homogènes** : `FINAL_REPORT` devient « Verdict », `LEVEL_EXECUTION` devient
   « En cours », `ENGINE_VALIDATED` devient « Instrument validé ».
4. **Les chiffres qui engagent** (débit observé, exigences atteintes) sont mis en avant ; les
   métadonnées sont repliées.
5. **Zéro jargon interne** dans l'interface : pas de `PLAN_FROZEN` brut.
6. **États vides utiles** : chaque écran dit quoi faire.
7. **Destructif = explicite** : l'arrêt d'une campagne demande confirmation et affiche ce qui sera
   conservé.
