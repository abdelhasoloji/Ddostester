# Déploiement & exploitation

Cible : serveur Ubuntu 24.04, Node 22, systemd. L'API/UI écoute en **loopback
uniquement** ; l'accès distant se fait par **tunnel SSH** (aucune exposition
publique — l'outil n'a pas d'authentification applicative).

## Prérequis

- Node 22 :
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- Accès SSH au serveur ; utilisateur avec `sudo`.
- Accès en lecture au dépôt (deploy key recommandée).

## Récupérer le code (deploy key)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ddostester_deploy -N "" -C "ddostester-deploy"
cat ~/.ssh/ddostester_deploy.pub    # → GitHub : repo → Settings → Deploy keys (lecture seule)

cat >> ~/.ssh/config <<'CFG'
Host github-ddostester
  HostName github.com
  User git
  IdentityFile ~/.ssh/ddostester_deploy
  IdentitiesOnly yes
CFG

git clone github-ddostester:abdelhasoloji/Ddostester.git ~/ddostester
```

## Déployer / mettre à jour

Le script `deploy/setup.sh` est **idempotent** : pull + install + build + tests
+ (ré)écriture du service systemd + vérification du bind loopback + health check.

```bash
cd ~/ddostester
bash deploy/setup.sh
```

Variables surchargeables :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `PORT` | `8080` | Port d'écoute (loopback) |
| `HOST` | `127.0.0.1` | Adresse d'écoute — **ne pas mettre `0.0.0.0`** |
| `ALLOWED_TARGETS` | `127.0.0.1,localhost` | Liste blanche des cibles/sondes |

Ajouter une cible autorisée :

```bash
ALLOWED_TARGETS="127.0.0.1,host-de-test.interne" bash deploy/setup.sh
```

## Persistance (PostgreSQL)

Par défaut, sans `DATABASE_URL`, l'API stocke campagnes et runs **en mémoire**
(perdus au redémarrage — pratique en dev/tests). Pour persister, fournir une
base PostgreSQL :

```bash
# option A — Postgres géré/installé, puis :
DATABASE_URL="postgresql://shieldtest:motdepasse@127.0.0.1:5432/shieldtest" \
  bash deploy/setup.sh

# option B — pile complète via Docker (API + Postgres) :
POSTGRES_PASSWORD=... ALLOWED_TARGETS="127.0.0.1,host.test" docker compose up -d --build
```

Le schéma (`campaigns`, `runs`) est créé automatiquement au démarrage
(idempotent). Les runs conservent `wrs`/`wrs_level` et la cible, base d'un
historique WRS par cible. Vérifier le backend actif :

```bash
curl -s localhost:8080/health   # {"storage":"postgres", ...}
```

## Accès à l'interface (tunnel SSH)

Depuis le **poste local** (pas le serveur) :

```bash
ssh -L 8080:127.0.0.1:8080 <user>@<serveur>
# tant que la session reste ouverte :
#   http://localhost:8080  → UI + API du serveur
```

## Service systemd

```bash
systemctl status ddostester
journalctl -u ddostester -n 50 --no-pager   # logs
sudo systemctl restart ddostester
```

Unité générée : `/etc/systemd/system/ddostester.service`
(`WorkingDirectory=<repo>/backend`, `ExecStart=/usr/bin/node dist/server.js`,
`Restart=on-failure`).

## Vérifications de sécurité

```bash
# 1) l'API ne doit écouter QUE sur le loopback
ss -tlnp | grep 8080          # attendu : 127.0.0.1:8080 uniquement

# 2) cibles autorisées effectives
curl -s localhost:8080/health # {"status":"ok","allowedTargets":[...]}
```

Si `ss` montre une IP publique (`0.0.0.0` ou une IP routable), **arrêter le
service** et redéployer avec `HOST=127.0.0.1`.

## Runbook incident

| Symptôme | Diagnostic | Action |
|----------|-----------|--------|
| `/health` ne répond pas | `journalctl -u ddostester` | corriger l'erreur, `systemctl restart` |
| API sur IP publique | `ss -tlnp \| grep 8080` | redéployer avec `HOST=127.0.0.1` |
| Campagne refusée (403/400) | message d'erreur de l'API | cible hors allowlist, non approuvée, ou plafond dépassé |
| Campagne bloquée en RUNNING | sonde/kill switch | `POST /api/campaigns/:id/kill` puis vérifier logs |

## TLS / mTLS (reverse-proxy)

Le TSD prévoit « HTTPS + mTLS ». Un reverse-proxy Caddy est fourni (profil Docker) :

```bash
SHIELDTEST_DOMAIN=shieldtest.interne POSTGRES_PASSWORD=... \
  docker compose --profile proxy up -d --build
```

- Termine TLS devant l'API (certificat interne auto-signé par défaut ; pour des
  certificats réels, ajuster `deploy/proxy/Caddyfile`).
- **mTLS** : décommenter le bloc `client_auth` du Caddyfile + monter la CA
  interne (`deploy/proxy/ca.crt`) pour exiger un certificat client WEDOS.

Alternative sans Docker : placer l'API loopback derrière le reverse-proxy interne
existant (Caddy/nginx) qui assure TLS et, si besoin, l'authentification mutuelle.

## Base : PostgreSQL ou TimescaleDB

Par défaut `postgres:16`. Pour activer TimescaleDB (séries temporelles WRS en
hypertable) :

```bash
DB_IMAGE=timescale/timescaledb:latest-pg16 POSTGRES_PASSWORD=... \
  docker compose up -d --build
```

L'application détecte l'extension au démarrage : si présente, `wrs_samples`
devient une hypertable ; sinon elle reste une table PostgreSQL standard
(fonctionnement identique). Aucun changement de configuration applicative requis.
