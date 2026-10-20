#!/usr/bin/env bash
# Update the staging instance from main and restart it.
#
#   sudo deploy/staging-update.sh
#
# Staging runs from its own checkout (/home/shieldtest/ddostester-staging) against its own
# database, so a schema change here never touches production and a broken staging build
# never blocks a deploy. It is updated on demand, not by the production workflow.
set -euo pipefail

REPO_DIR="${STAGING_REPO_DIR:-/home/shieldtest/ddostester-staging}"
SERVICE="${STAGING_SERVICE:-ddostester-staging}"
SVC_USER="${STAGING_USER:-shieldtest}"
ENV_FILE="${STAGING_ENV_FILE:-/etc/ddostester-staging.env}"

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: run as root (it restarts a systemd unit).' >&2
  exit 1
fi
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: no checkout at $REPO_DIR." >&2
  exit 1
fi

runuser -u "$SVC_USER" -- bash -lc "cd '$REPO_DIR' && git fetch --quiet origin main && git checkout --quiet origin/main"
COMMIT="$(runuser -u "$SVC_USER" -- bash -lc "cd '$REPO_DIR' && git rev-parse --short HEAD")"
echo "staging checkout at $COMMIT"

# Both workspaces: the service serves the UI as well as the API, and a backend-only build
# answers 404 on / while /health is green -- which reads as "the app is down" to a client.
runuser -u "$SVC_USER" -- bash -lc "cd '$REPO_DIR' && npm ci --ignore-scripts --no-audit --fund=false && npm run build"

# Migrations run at startup; the account migration must have been applied once already.
set -a
. "$ENV_FILE"
set +a
runuser -u "$SVC_USER" --preserve-environment -- bash -lc "cd '$REPO_DIR/backend' && node dist/cli/migrate-users.js --apply" >/dev/null

systemctl restart "$SERVICE"
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 2 "http://127.0.0.1:${STAGING_PORT:-8081}/health" >/dev/null; then
    echo "staging healthy at $COMMIT"
    exit 0
  fi
done
echo 'ERROR: staging did not become healthy; check journalctl -u '"$SERVICE"' -n 50' >&2
exit 1
