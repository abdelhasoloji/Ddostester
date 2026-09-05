#!/usr/bin/env bash
# WEDOS ShieldTest — déploiement/mise à jour idempotent sur le serveur.
# Usage :
#   bash deploy/setup.sh                 # build + (re)start, allowlist inchangée
#   ALLOWED_TARGETS="127.0.0.1,host.test.interne" bash deploy/setup.sh
#
# Ne fait AUCUNE exposition publique : l'API écoute sur 127.0.0.1 (accès via
# tunnel SSH). N'ajoute une cible que si tu la passes explicitement en env.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="ddostester"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
ALLOWED_TARGETS="${ALLOWED_TARGETS:-127.0.0.1,localhost}"
# Persistance : si DATABASE_URL est défini, l'API utilise PostgreSQL ; sinon,
# stockage en mémoire (perdu au redémarrage).
DATABASE_URL="${DATABASE_URL:-}"
# Auth (optionnelle) : si AUTH_JWT_SECRET est défini, l'auth+RBAC est activée.
AUTH_JWT_SECRET="${AUTH_JWT_SECRET:-}"
AUTH_USERS="${AUTH_USERS:-}"
# Agent de charge (builtin par défaut ; k6 délègue à l'outil externe).
AGENT="${AGENT:-builtin}"
RUN_USER="${SUDO_USER:-$(id -un)}"

echo "==> Répertoire : $REPO_DIR"
echo "==> Cibles autorisées (allowlist) : $ALLOWED_TARGETS"

cd "$REPO_DIR"
echo "==> git pull"
git pull --ff-only || echo "   (pull ignoré : dépôt local modifié ou hors-ligne)"

echo "==> npm install + build + test"
npm install
npm run build
npm test

echo "==> Écriture des secrets (EnvironmentFile, chmod 600)"
# Les valeurs sensibles/complexes (secret JWT, utilisateurs JSON, DSN base) vont
# dans un fichier d'environnement protégé, pas dans l'unité systemd (lisible par
# tous). Les lignes ne sont écrites que si la variable est fournie.
ENVFILE="/etc/${SERVICE}.env"
sudo touch "$ENVFILE"
sudo chmod 600 "$ENVFILE"
{
  echo "# Généré par deploy/setup.sh — secrets runtime (ne pas committer)."
  [ -n "$DATABASE_URL" ] && echo "DATABASE_URL=$DATABASE_URL"
  [ -n "$AUTH_JWT_SECRET" ] && echo "AUTH_JWT_SECRET=$AUTH_JWT_SECRET"
  [ -n "$AUTH_USERS" ] && echo "AUTH_USERS=$AUTH_USERS"
} | sudo tee "$ENVFILE" >/dev/null

echo "==> Écriture du service systemd"
sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=WEDOS ShieldTest control plane
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}/backend
Environment=PORT=${PORT}
Environment=HOST=${HOST}
Environment=ALLOWED_TARGETS=${ALLOWED_TARGETS}
Environment=AGENT=${AGENT}
EnvironmentFile=-${ENVFILE}
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

echo "==> (re)démarrage du service"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE}"
sudo systemctl restart "${SERVICE}"
sleep 1

echo "==> Vérification bind loopback (doit être UNIQUEMENT ${HOST}:${PORT})"
if command -v ss >/dev/null; then ss -tlnp 2>/dev/null | grep ":${PORT}" || true; fi

echo "==> Health check"
curl -fsS "http://${HOST}:${PORT}/health" && echo

cat <<MSG

✅ Déployé. L'API + l'UI écoutent sur http://${HOST}:${PORT} (loopback).
   Accès depuis ton poste (tunnel SSH, aucune exposition publique) :

     ssh -L ${PORT}:127.0.0.1:${PORT} ${RUN_USER}@<IP-publique-du-serveur>

   puis ouvre http://localhost:${PORT} dans ton navigateur.
MSG
