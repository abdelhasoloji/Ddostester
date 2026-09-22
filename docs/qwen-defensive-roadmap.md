# Feuille de route d'améliorations — WEDOS ShieldTest

_Rôle : pentester DDoS **éthique** (tests de résilience sous autorisation, bornés)._
_Cadre non négociable respecté : aucun vecteur offensif ajouté au control plane ; mesure / gouvernance / défense uniquement._

> Rédigé par **Qwen3-27B** (LLM local, persona hacker éthique) après lecture du CLAUDE.md, de la doc de gouvernance/frontière, de l'architecture et des modules réels.
> Document consultatif — chaque chantier reste à valider par l'équipe avant implémentation.

---

Voici une feuille de route d’améliorations pour le control plane **WEDOS ShieldTest**, strictement alignée sur sa frontière non négociable : **mesure bornée, gouvernance forte, aucun vecteur offensif ajouté**.

---

## 1. Mesure & scoring de résilience (WRS, métriques, baseline)

### 1.1. Rendre le WRS plus discriminant et anti-gaming

- **Quoi** : enrichir la fonction de scoring (`backend/src/modules/wrs/scoring.ts`) avec des métriques de **stabilité sous charge** (variance de latence p50/p95, taux de 5xx vs timeouts, dégradation du baseline) et un **pénalité explicite** si la disponibilité “tient” mais que la latence explose (faux positif de résilience).
- **Pourquoi** : aujourd’hui, un target peut “survivre” avec une disponibilité correcte mais une latence inutilisable ; le score actuel peut masquer cette dégradation.
- **Effort** : **M**
- **Côté** : **mesure**

### 1.2. Baseline dynamique + détection de drift plus fine

- **Quoi** : étendre `backend/src/modules/campaigns/baseline.ts` pour capturer une **baseline multi-états** (idle, léger, modéré) et alerter sur **drift progressif** (pas seulement un seuil binaire). Ajouter un **score de baseline** dans le WRS.
- **Pourquoi** : une baseline unique peut être biaisée par l’état du target au moment du test ; un drift progressif est un signal précoce de fatigue.
- **Effort** : **M**
- **Côté** : **mesure**

### 1.3. Corrélation WRS ↔ événements de protection (TTD/TTM)

- **Quoi** : dans `backend/src/modules/protection/provider.ts`, **lier explicitement** les timestamps de détection/mitigation aux **fenêtres de charge** (phases, rampes) et exposer un **delta WRS** avant/après mitigation.
- **Pourquoi** : aujourd’hui, TTD/TTM sont mesurés mais leur impact sur le score global est implicite ; une corrélation explicite rend le score plus actionnable.
- **Effort** : **S**
- **Côté** : **mesure**

---

## 2. Gouvernance & autorisation (scope, RoE, approbation, audit, kill-switch)

### 2.1. Enrichir l’attestation avec un **scope signé et horodaté**

- **Quoi** : dans `backend/src/modules/campaigns/service.ts`, exiger un **objet `scope`** structuré (targets, fenêtres horaires, RPS max, durée max, exceptions) **signé par l’officer** et vérifié à l’exécution.
- **Pourquoi** : l’attestation actuelle est déclarative ; un scope signé réduit le risque de dérive entre autorisation et exécution.
- **Effort** : **M**
- **Côté** : **gouvernance**

### 2.2. Kill-switch plus granulaire (par phase, par endpoint)

- **Quoi** : étendre `backend/src/modules/probe/probe.ts` et `backend/src/engine/loadTest.ts` pour permettre un **kill par phase** (ex. arrêter la rampe mais pas le steady-state) et un **kill par endpoint** (ex. arrêter `/api/v1` mais pas `/health`).
- **Pourquoi** : un kill global peut être trop brutal ; une granularité fine permet de mesurer la résilience partielle.
- **Effort** : **L**
- **Côté** : **gouvernance**

### 2.3. Audit enrichi avec **contexte de décision**

- **Quoi** : dans `backend/src/modules/audit/integrity.ts`, ajouter un champ `decisionContext` (ex. “kill auto car p95 > 2s pendant 10s”) et l’exposer dans l’export JSON.
- **Pourquoi** : aujourd’hui, l’audit enregistre l’action mais pas la raison ; un contexte enrichi facilite la revue post-incident.
- **Effort** : **S**
- **Côté** : **gouvernance**

---

## 3. Couverture de test bornée & réaliste (générateur HTTP capé, slow-header probe, adaptateurs k6/Vegeta/Locust)

### 3.1. Améliorer le **slow-header probe** (`http-slowloris`)

- **Quoi** : dans `backend/src/engine/slowloris.ts`, ajouter un **mode “slow-body”** (envoi lent du body) et un **mode “slow-keep-alive”** (maintien de connexion sans requête) pour couvrir plus de scénarios de slowloris.
- **Pourquoi** : le slowloris classique est couvert, mais les variantes (slow body, keep-alive idle) sont fréquentes en production.
- **Effort** : **M**
- **Côté** : **mesure**

### 3.2. Adapter les **adaptateurs k6/Vegeta/Locust** pour les **scénarios multi-phases**

- **Quoi** : dans `backend/src/agents/k6.ts`, `vegeta.ts`, `locust.ts`, implémenter la **génération de scripts** (k6 JS, Vegeta JSON, Locust Python) avec **phases** (ramp, steady, spike) et **corrélation** (ex. login → API).
- **Pourquoi** : aujourd’hui, les adaptateurs sont limités aux scénarios simples ; des scénarios réalistes (multi-phases, corrélation) sont nécessaires pour une mesure fidèle.
- **Effort** : **L**
- **Côté** : **mesure**

### 3.3. Ajouter un **mode “chaos”** borné (ex. 10% de requêtes malformées)

- **Quoi** : dans `backend/src/engine/loadTest.ts`, ajouter un **mode “chaos”** qui envoie un pourcentage configurable (ex. 10%) de requêtes avec des headers invalides, des bodies tronqués, ou des URLs inattendues (toujours dans l’allowlist).
- **Pourquoi** : un target résilient doit gérer les requêtes malformées sans crasher ; ce mode mesure la **robustesse** sans ajouter de vecteur offensif.
- **Effort** : **M**
- **Côté** : **mesure**

---

## 4. Validation de la mitigation & télémétrie (corrélation)

### 4.1. Corrélation **WRS ↔ télémétrie cible** (CPU, conntrack, NIC)

- **Quoi** : dans `backend/src/modules/target-telemetry/provider.ts`, **lier** les métriques de télémétrie (CPU, conntrack, NIC) aux **fenêtres de charge** et exposer un **delta WRS** avant/après mitigation.
- **Pourquoi** : aujourd’hui, la télémétrie est collectée mais pas corrélée au score ; une corrélation explicite rend la mitigation plus actionnable.
- **Effort** : **M**
- **Côté** : **mesure**

### 4.2. Ajouter un **mode “mitigation-only”** (pas de charge, seulement mesure)

- **Quoi** : dans `backend/src/modules/campaigns/runner.ts`, ajouter un **mode “mitigation-only”** qui ne génère pas de charge mais **mesure** la disponibilité, la latence, et la télémétrie.
- **Pourquoi** : un mode “mitigation-only” permet de mesurer l’impact d’une mitigation sans générer de charge, utile pour la **validation** d’une règle.
- **Effort** : **S**
- **Côté** : **gouvernance**

### 4.3. Corrélation **WRS ↔ événements de protection** (TTD/TTM)

- **Quoi** : dans `backend/src/modules/protection/provider.ts`, **lier** les timestamps de détection/mitigation aux **fenêtres de charge** et exposer un **delta WRS** avant/après mitigation.
- **Pourquoi** : aujourd’hui, TTD/TTM sont mesurés mais leur impact sur le score global est implicite ; une corrélation explicite rend le score plus actionnable.
- **Côté** : **mesure**

---

- **Effort** : **M**
- **Côté** : **mesure**

---

## 5. Detection/observabilite & reporting de conformite (DORA/NIS2)

### 5.1. Pipeline d’alerting unifié avec enrichissement contextuel (WRS + TTD/TTM)

- **Quoi** : dans `backend/src/modules/alerts/provider.ts` et `notify`, implémenter un **correlator** qui agrège les événements bruts (détection, mitigation, pic CPU/conntrack) en **incidents structurés** avec un champ `wrs_delta` et `ttm_ms`. Ajouter une règle de **dé-duplication** basique (fenêtre glissante 5 min) pour éviter le bruit.
- **Pourquoi** : aujourd’hui, les alertes sont souvent des signaux isolés. Pour NIS2/DORA, il faut prouver la **maîtrise de l’incident** (détection → réponse → impact mesuré). Un incident enrichi est directement exploitable dans les rapports de conformité et réduit le MTTR.
- **Effort** : **M**
- **Côté** : **gouvernance**

### 5.2. Génération automatique de rapports de conformité (DORA/NIS2)

- **Quoi** : dans `backend/src/modules/reports/provider.ts`, créer un **template de rapport** qui exporte (PDF/JSON) :
  - Taux de disponibilité par période
  - TTD/TTM moyens et médians
  - Delta WRS moyen lors des incidents
  - Liste des mitigations appliquées et leur efficacité
- **Pourquoi** : NIS2 exige la **documentation des incidents** et des mesures de sécurité. DORA met l’accent sur la **fiabilité** et la **mesure de la performance**. Un rapport généré automatiquement élimine le travail manuel et garantit la traçabilité.
- **Effort** : **M**
- **Côté** : **gouvernance**

### 5.3. Dashboard d’observabilité temps réel avec SLO/SLI

- **Quoi** : dans `backend/src/modules/observability/provider.ts`, exposer des **SLI** (Service Level Indicators) clés :
  - `availability_ratio` (disponibilité)
  - `p99_latency` (latence)
  - `wrs_stability` (stabilité du score)
  - `ttm_p95` (temps de mitigation)
    Ajouter une vue **temps réel** (WebSocket ou polling) pour les équipes de sécurité.
- **Pourquoi** : Les SLO/SLI sont la base de la **mesure de la performance** (DORA) et de la **surveillance continue** (NIS2). Un dashboard centralisé permet de détecter les dérives avant qu’elles ne deviennent des incidents.
- **Effort** : **L**
- **Côté** : **mesure**

---

## 6. Robustesse & securite du control plane lui-meme (authz, secrets, tests, CI)

### 6.1. Renforcement de l’authentification et de l’autorisation (RBAC)

- **Quoi** : dans `backend/src/modules/users/auth`, implémenter un **RBAC** (Role-Based Access Control) avec des rôles clairs :
  - `viewer` : lecture seule
  - `operator` : création de campagnes, lecture des résultats
  - `admin` : gestion des utilisateurs, configuration des règles
    Ajouter des **claims** dans les tokens JWT pour stocker le rôle et les permissions.
- **Pourquoi** : Aujourd’hui, l’accès est probablement binaire (auth/non-auth). Un RBAC permet de **limiter la surface d’attaque** et de respecter le principe du moindre privilège, essentiel pour la conformité NIS2.
- **Effort** : **M**
- **Côté** : **sécurité**

### 6.2. Gestion sécurisée des secrets et configuration

- **Quoi** : dans `backend/src/config`, utiliser un **secret manager** (ex. : HashiCorp Vault, AWS Secrets Manager, ou au minimum `.env` avec validation stricte) pour stocker les clés API, tokens, et mots de passe. Ajouter une **validation de configuration** au démarrage (fail-fast) pour éviter les erreurs de configuration en production.
- **Pourquoi** : Les fuites de secrets sont une cause majeure de compromission. Une gestion centralisée et validée réduit le risque et facilite l’audit.
- **Effort** : **S**
- **Côté** : **sécurité**

### 6.3. Amélioration de la couverture de tests et de la CI

- **Quoi** :
  - **Vitest** : augmenter la couverture des modules critiques (`auth`, `protection`, `telemetry`) à >80 %.
  - **Playwright** : ajouter des tests E2E pour les flux clés (création de campagne, visualisation des résultats, gestion des alertes).
  - **GitHub Actions** : ajouter un **job de sécurité** (SAST avec ESLint, dépendances avec `npm audit`, et un scan de secrets avec `gitleaks`).
- **Pourquoi** : Une CI robuste garantit la **qualité du code** et détecte les vulnérabilités tôt. Les tests E2E assurent que les fonctionnalités critiques fonctionnent dans un environnement réel.
- **Effort** : **M**
- **Côté** : **qualité**

---

## TOP 3 priorise (impact/effort)

1. **5.1. Pipeline d’alerting unifié avec enrichissement contextuel**
   - **Justification** : **Impact élevé** (meilleure détection, réduction du MTTR, conformité NIS2) / **Effort moyen**. C’est la fondation pour toute la suite (rapports, dashboards). Sans alerting structuré, les autres améliorations sont moins efficaces.

2. **6.1. Renforcement de l’authentification et de l’autorisation (RBAC)**
   - **Justification** : **Impact élevé** (sécurité du control plane, conformité NIS2) / **Effort moyen**. C’est une exigence de base pour tout système de contrôle. Un RBAC bien implémenté réduit la surface d’attaque et facilite l’audit.

3. **4.1. Corrélation WRS ↔ télémétrie cible**
   - **Justification** : **Impact élevé** (mesure précise de l’efficacité des mitigations) / **Effort moyen**. C’est la clé pour prouver que les mitigations fonctionnent. Sans cette corrélation, le score WRS reste un indicateur isolé, moins actionnable.
