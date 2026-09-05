# Documentation — WEDOS ShieldTest (Control Plane)

Plan de contrôle interne pour tests de résilience. Ce dossier regroupe la
documentation technique et opérationnelle.

| Document | Contenu |
|----------|---------|
| [architecture.md](./architecture.md) | Vue d'ensemble, modules, flux d'une campagne |
| [deployment.md](./deployment.md) | Déploiement serveur, systemd, tunnel SSH, mise à jour |
| [usage.md](./usage.md) | Parcours complet : créer → approuver → exécuter → rapport |
| [api.md](./api.md) | Référence des endpoints REST avec exemples `curl` |
| [auth.md](./auth.md) | Authentification JWT, rôles (RBAC), séparation des rôles |
| [wrs.md](./wrs.md) | Formule et interprétation du WEDOS Resiliency Score |
| [safeguards.md](./safeguards.md) | Modèle de sécurité, périmètre, ce qui n'est pas implémenté |
| [offensive-integration.md](./offensive-integration.md) | Génération de charge : agents (builtin/k6), gouvernance, L3/L4 externe |
| [security-review.md](./security-review.md) | Revue de sécurité (menaces, points vérifiés, risques résiduels) |
| [monitoring.md](./monitoring.md) | Prometheus + Grafana (dashboard provisionné) |
| [stack-vs-tsd.md](./stack-vs-tsd.md) | Correspondance stack réalisé vs spécifications TSD |

> ⚠️ **Périmètre défensif.** Cet outil orchestre, mesure et score des tests de
> charge **HTTP bornés** contre une infrastructure autorisée. Il n'implémente
> **aucun vecteur d'attaque** (flood L3/L4, amplification, épuisement L7).
> Voir [safeguards.md](./safeguards.md).
