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
