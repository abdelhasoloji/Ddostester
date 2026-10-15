#!/usr/bin/env bash
# Build and promote an immutable release. Never reset a checkout or rewrite secrets.
set -euo pipefail
REPO_DIR="${DEPLOY_SOURCE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
SERVICE="${DEPLOY_SERVICE:-ddostester}"
BRANCH="${DEPLOY_BRANCH:-main}"
MODE="${DEPLOY_MODE:-systemd}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
cd "$REPO_DIR"
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: checkout contains local work; commit or use a separate clean checkout." >&2
  exit 1
fi
if [ "$MODE" != systemd ]; then
  echo "ERROR: automatic promotion supports systemd only; build a versioned container image and verify its release manifest for Docker." >&2
  exit 1
fi
git check-ref-format --branch "$BRANCH" >/dev/null
EXPECTED="${DEPLOY_EXPECTED_COMMIT:-}"
if [ -n "$EXPECTED" ]; then
  if [[ ! "$EXPECTED" =~ ^[0-9a-f]{40}$ ]]; then echo "ERROR: expected commit must be a full SHA." >&2; exit 1; fi
  git fetch origin "$EXPECTED"
  REV="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
  if [ "$REV" != "$EXPECTED" ]; then echo "ERROR: fetched commit differs from passed CI." >&2; exit 1; fi
else
  git fetch origin "$BRANCH"
  REV="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
fi
SHORT="$(git rev-parse --short "$REV")"
BUILD="$(git rev-list --count "$REV")"
RELEASES="${DEPLOY_RELEASES_DIR:-$(dirname "$REPO_DIR")/ddostester-releases}"
mkdir -p "$RELEASES"
RELEASE="$(mktemp -d "$RELEASES/release-${SHORT}.XXXXXX")"
git archive "$REV" | tar -x -C "$RELEASE"
cd "$RELEASE"
npm ci --ignore-scripts
SHIELDTEST_COMMIT="$SHORT" SHIELDTEST_BUILD="$BUILD" npm run verify
node scripts/release-manifest.mjs
# The service may run under a different, unprivileged account. No runtime secrets are copied.
chmod -R a+rX "$RELEASE"
# Promotion is reached only after the complete gate succeeds.
DROPIN="/etc/systemd/system/${SERVICE}.service.d/40-verified-release.conf"
BACKUP="$(mktemp)"
HAD_DROPIN=0
if sudo -n test -f "$DROPIN"; then sudo -n cat "$DROPIN" > "$BACKUP"; HAD_DROPIN=1; fi
OVERRIDE="$(mktemp)"
printf '[Service]\nWorkingDirectory=%s/backend\nExecStart=\nExecStart=/usr/bin/node %s/backend/dist/server.js\n' "$RELEASE" "$RELEASE" > "$OVERRIDE"
# Keep service-level runtime overrides (for example persistent Fleet enablement)
# separate from the changing release paths, including continued directives.
if [ "$HAD_DROPIN" = 1 ]; then
  awk '
    /^[[:space:]]*Environment(File)?=/ { keep = 1 }
    keep { print; keep = ($0 ~ /\\$/) }
  ' "$BACKUP" >> "$OVERRIDE"
fi
sudo -n mkdir -p "$(dirname "$DROPIN")"
sudo -n install -m 644 "$OVERRIDE" "$DROPIN"
rollback() {
  if [ "$HAD_DROPIN" = 1 ]; then sudo -n install -m 644 "$BACKUP" "$DROPIN"; else sudo -n unlink "$DROPIN"; fi
  sudo -n systemctl daemon-reload
  sudo -n systemctl restart "$SERVICE"
}
if ! sudo -n systemctl daemon-reload || ! sudo -n systemctl restart "$SERVICE"; then
  rollback
  echo 'ERROR: promotion failed; restored previous service definition.' >&2
  exit 1
fi
VALID=0
for attempt in 1 2 3 4 5 6 7 8; do
  if node scripts/verify-release.mjs release-manifest.json "http://${HOST}:${PORT}"; then VALID=1; break; fi
  sleep 2
done
if [ "$VALID" != 1 ]; then
  rollback
  echo 'ERROR: release identity/readiness/assets failed; restored previous service definition.' >&2
  exit 1
fi
echo "Verified promotion: $RELEASE"
