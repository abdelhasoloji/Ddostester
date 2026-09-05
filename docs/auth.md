# Authentification & RBAC

Auth par **JWT (HS256)** auto-portée, activée **uniquement** si
`AUTH_JWT_SECRET` est défini (sinon mode dev sans auth, identité saisie à la
main). Conçue pour accepter plus tard des tokens Keycloak (même schéma).

## Rôles (TSD §4.1)

| Rôle | Droits |
|------|--------|
| `engineer` (Security Engineer) | créer, exécuter, kill, lecture |
| `officer` (Security Officer) | **approuver/rejeter** + tout ce que fait l'engineer |
| `viewer` (SOC / NOC) | lecture + **kill switch** d'urgence |

- **Séparation des rôles** : l'approbateur (officer) doit être différent de
  l'auteur ; l'auteur et l'approbateur sont **dérivés du token** (non usurpables
  via le corps de requête).

## Configuration

```bash
# 1) secret JWT (long, aléatoire)
export AUTH_JWT_SECRET="$(openssl rand -hex 32)"

# 2) hacher les mots de passe
npm run hash-password -w backend -- MonMotDePasse
# -> scrypt$....

# 3) déclarer les utilisateurs (JSON une ligne)
export AUTH_USERS='[
  {"email":"eng@wedos","role":"engineer","passwordHash":"scrypt$..."},
  {"email":"off@wedos","role":"officer","passwordHash":"scrypt$..."},
  {"email":"soc@wedos","role":"viewer","passwordHash":"scrypt$..."}
]'

# 4) déployer (les secrets vont dans /etc/ddostester.env, chmod 600)
AUTH_JWT_SECRET="$AUTH_JWT_SECRET" AUTH_USERS="$AUTH_USERS" bash deploy/setup.sh
```

`GET /health` indique `authRequired: true|false`.

## Endpoints

| Méthode | Route | Rôle requis |
|--------|-------|-------------|
| POST | `/api/auth/login` | — (retourne un token) |
| GET | `/api/auth/me` | authentifié |
| POST | `/api/campaigns` | engineer/officer |
| POST | `/api/campaigns/:id/approval` | **officer** |
| POST | `/api/campaigns/:id/execute` | engineer/officer |
| POST | `/api/campaigns/:id/kill` | tous |
| GET | `/api/campaigns`, `/api/runs`, rapport | tous (lecture) |

Envoyer le token via l'en-tête `Authorization: Bearer <token>`. Le rapport
(ouvert dans un onglet) accepte aussi `?token=<token>`.
