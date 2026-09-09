#!/usr/bin/env bash
# WEDOS ShieldTest — CD update: pull the latest code, redeploy, health-check.
#
# Safe to run non-interactively from CI. Unlike deploy/setup.sh (one-time
# provisioning), this script does NOT touch /etc/ddostester.env nor the systemd
# unit, so it never overwrites runtime secrets or the service definition. It
# only brings the code up to date and (re)starts the service, rolling back to
# the previous commit if the new revision fails its health check.
#
# Two deployment models are supported via DEPLOY_MODE:
#   systemd (default) — native Node + systemd: npm ci, build, test, then
#                       `systemctl restart ddostester`.
#   docker            — Docker Compose: `docker compose up -d --build` (the api
#                       image builds and serves both API and UI). The image
#                       build is the gate; CI already ran lint/typecheck/tests
#                       on main. Secrets come from the environment or a .env
#                       file next to docker-compose.yml (compose reads it).
#
# Usage (on the server, or from the self-hosted CI runner):
#   bash deploy/update.sh                          # systemd, deploy origin/main
#   DEPLOY_MODE=docker bash deploy/update.sh        # Docker Compose, origin/main
#   DEPLOY_BRANCH=main DEPLOY_MODE=docker bash deploy/update.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="ddostester"
BRANCH="${DEPLOY_BRANCH:-main}"
MODE="${DEPLOY_MODE:-systemd}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"

# Compose command detection (v2 plugin `docker compose`, or legacy standalone).
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

cd "$REPO_DIR"

# Remember the currently-deployed commit so we can roll back on failure.
PREV="$(git rev-parse HEAD)"

deploy_current() {
  case "$MODE" in
    docker)
      # The api image builds backend + frontend and runs the DB; compose
      # recreates only the containers whose build/config changed.
      "${COMPOSE[@]}" up -d --build
      ;;
    systemd)
      npm ci
      # Stamp the UI version from this (known-good) git context and pass it to
      # the build via env: git inside Vite can fail on the server (dubious
      # ownership / sanitized HOME), which used to leave the footer at "+0 · dev".
      SHIELDTEST_COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)" \
      SHIELDTEST_BUILD="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)" \
        npm run build
      npm test
      sudo -n systemctl restart "${SERVICE}"
      ;;
    *)
      echo "ERROR: unknown DEPLOY_MODE='${MODE}' (expected 'systemd' or 'docker')." >&2
      return 2
      ;;
  esac
}

# Health check with a few retries (the service needs a moment to bind). The API
# publishes ${HOST}:${PORT} on loopback in both models, so this is identical.
health_ok() {
  for _ in 1 2 3 4 5 6 7 8; do
    if curl -fsS "http://${HOST}:${PORT}/ready" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

echo "==> Deployment mode: ${MODE}"
echo "==> Fetching origin/${BRANCH}"
git fetch --prune origin "${BRANCH}"
# Match the remote exactly (discards local drift; gitignored dist/ & node_modules stay).
git reset --hard "origin/${BRANCH}"

echo "==> Deploy (aborts here if the build/restart fails)"
if ! deploy_current; then
  echo "ERROR: deploy step failed." >&2
  if [ "$MODE" = "systemd" ]; then
    echo "(If restart failed, grant the deploy user passwordless sudo — see docs/ci-cd.md.)" >&2
  fi
  # fall through to rollback
fi

echo "==> Health check (/ready)"
if health_ok; then
  echo "✅ Update deployed on http://${HOST}:${PORT} (loopback)."
  exit 0
fi

echo "❌ Health check failed after deploy — rolling back to ${PREV}." >&2
git reset --hard "${PREV}"
if deploy_current && health_ok; then
  echo "↩️  Rolled back to ${PREV}; service healthy again." >&2
else
  echo "FATAL: rollback also failed — manual intervention required." >&2
fi
exit 1
