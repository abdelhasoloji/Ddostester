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

# Remember the currently-deployed commit so we can roll back on failure.
PREV="$(git rev-parse HEAD)"

build_and_restart() {
  npm ci
  npm run build
  npm test
  sudo -n systemctl restart "${SERVICE}"
}

# Health check with a few retries (the service needs a moment to bind).
health_ok() {
  for _ in 1 2 3 4 5; do
    if curl -fsS "http://${HOST}:${PORT}/ready" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

echo "==> Fetching origin/${BRANCH}"
git fetch --prune origin "${BRANCH}"
# Match the remote exactly (discards local drift; gitignored dist/ & node_modules stay).
git reset --hard "origin/${BRANCH}"

echo "==> Build + tests + restart (deploy aborts here if build/tests fail)"
if ! build_and_restart; then
  echo "ERROR: build/restart failed." >&2
  echo "(If restart failed, grant the deploy user passwordless sudo — see docs/ci-cd.md.)" >&2
  # fall through to rollback
fi

echo "==> Health check (/ready)"
if health_ok; then
  echo "✅ Update deployed on http://${HOST}:${PORT} (loopback)."
  exit 0
fi

echo "❌ Health check failed after deploy — rolling back to ${PREV}." >&2
git reset --hard "${PREV}"
if build_and_restart && health_ok; then
  echo "↩️  Rolled back to ${PREV}; service healthy again." >&2
else
  echo "FATAL: rollback also failed — manual intervention required." >&2
fi
exit 1
