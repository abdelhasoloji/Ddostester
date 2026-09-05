# Revue de sécurité (auto-évaluation)

Synthèse de la posture de sécurité du control plane. Outil **interne**, à
n'exposer que derrière loopback + tunnel SSH ou reverse-proxy TLS/mTLS.

## Modèle de menace

| Menace                            | Traitement                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| Usage de l'outil contre des tiers | Allowlist obligatoire + attestation ; hors périmètre = refus 400/403      |
| Exposition publique de l'API      | Bind loopback par défaut ; reverse-proxy TLS/mTLS pour tout accès distant |
| Élévation de privilèges           | RBAC (engineer/officer/viewer) sur chaque route ; séparation des rôles    |
| Usurpation d'auteur/approbateur   | Dérivés du token JWT, jamais du corps de requête                          |
| Vol d'identifiants                | Mots de passe scrypt ; verrou anti-brute-force (5 échecs → 60 s)          |
| Fuite de token dans les logs      | Redaction `?token=` + en-tête Authorization non loggué                    |
| Injection SQL                     | Requêtes 100 % paramétrées (`pg`)                                         |
| Charge non maîtrisée              | Plafonds durs (RPS ≤ 2000, durée ≤ 900 s), kill switch 3 niveaux          |

## Points vérifiés

- **JWT HS256** : signature recalculée et comparée en temps constant
  (`timingSafeEqual`) ; `exp` vérifié ; l'algorithme du header n'est pas
  utilisé pour choisir la vérification (pas de faille `alg:none`).
- **Gardes de permission** sur toutes les routes `/api` (tests d'intégration :
  401 sans token, 403 selon le rôle).
- **Séparation des rôles** à l'approbation (approbateur ≠ auteur), testée.
- **Liste blanche** cible + sonde ; protocoles `http`/`https` seulement.
- **Rapport / SSE** : token de lecture accepté en query pour les liens
  navigateur, vérifié via la même logique de permission.

## Risques résiduels (acceptés / à traiter par l'exploitant)

- **Pas d'authentification sur `/metrics`** (agrégats non sensibles ; réseau
  interne). À protéger via le reverse-proxy si nécessaire.
- **CORS `origin: true`** : nécessaire au dev (UI Vite sur un autre port).
  Sans cookies (auth Bearer), pas de CSRF ; en prod l'UI est servie en même
  origine. Restreindre via le proxy si souhaité.
- **Attestation d'autorisation** : barrière déclarative — la responsabilité
  du périmètre incombe à l'opérateur (cf. SECURITY.md).
- **mTLS** : fourni au niveau du reverse-proxy (Caddy), pas applicatif.

## Ce que l'outil ne fait pas (par conception)

Aucun vecteur d'attaque (floods L3/L4, amplification, épuisement L7). Le seul
générateur est HTTP borné. Voir [safeguards.md](./safeguards.md).
