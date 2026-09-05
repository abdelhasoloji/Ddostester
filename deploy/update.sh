#!/usr/bin/env bash
# WEDOS ShieldTest — CD update: pull the latest code, rebuild, test, restart.
#
# Safe to run non-interactively from CI. Unlike deploy/setup.sh (one-time
# provisioning), this script does NOT touch /etc/ddostester.env nor the systemd
# unit, so it never overwrites runtime secrets or the service definition. It
# only brings the code up to date and restarts the service.
#
# Usage (on the server, or over SSH from CI):
#   bash deploy/update.sh                 # deploy origin/main
#   DEPLOY_BRANCH=main bash deploy/update.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="ddostester"
BRANCH="${DEPLOY_BRANCH:-main}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"

cd "$REPO_DIR"

echo "==> Fetching origin/${BRANCH}"
git fetch --prune origin "${BRANCH}"
# Match the remote exactly (discards local drift; gitignored dist/ & node_modules stay).
git reset --hard "origin/${BRANCH}"

echo "==> Installing dependencies (npm ci)"
npm ci

echo "==> Build + tests (deploy aborts here if anything fails)"
npm run build
npm test

echo "==> Restarting ${SERVICE}"
# Non-interactive: the deploy user needs passwordless sudo for this command.
if ! sudo -n systemctl restart "${SERVICE}"; then
  echo "ERROR: 'sudo -n systemctl restart ${SERVICE}' failed." >&2
  echo "Grant the deploy user passwordless sudo for systemctl (see docs/ci-cd.md)." >&2
  exit 1
fi
sleep 1

echo "==> Health check"
curl -fsS "http://${HOST}:${PORT}/health" && echo
echo "✅ Update deployed on http://${HOST}:${PORT} (loopback)."
