# Politique de sécurité et d'usage

Cet outil est réservé à un **usage interne autorisé** : test de résilience
d'infrastructures que l'organisation possède ou pour lesquelles elle détient un
mandat écrit.

## Usage acceptable
- Cibles inscrites dans la liste blanche `ALLOWED_TARGETS`.
- Campagnes approuvées par un rôle distinct de l'auteur (Security Officer).
- Débit et durée dans les plafonds `HARD_CAPS`.

## Usage interdit
- Toute campagne contre un système tiers sans autorisation écrite.
- Tout contournement des garde-fous (allowlist, plafonds, approbation).
- Toute extension ajoutant des vecteurs volumétriques ou d'épuisement destinés
  à saturer un service tiers.

## Signalement
Signaler tout abus ou faille via le canal sécurité interne WEDOS.
