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
# The default sits next to the deploy checkout. A promotion run as a different user
# (typically root) leaves it owned by that user, and every later deploy then died on
# `mktemp` with "Permission denied" before building anything. When the operator has
# not pinned a directory, fall back to a path the deploy user owns instead of failing.
if [ -z "${DEPLOY_RELEASES_DIR:-}" ] && ! { mkdir -p "$RELEASES" 2>/dev/null && [ -w "$RELEASES" ]; }; then
  RELEASES="$HOME/.ddostester-releases"
  echo "WARN: $(dirname "$REPO_DIR")/ddostester-releases is not writable; using $RELEASES" >&2
fi
mkdir -p "$RELEASES"
RELEASE="$(mktemp -d "$RELEASES/release-${SHORT}.XXXXXX")"
git archive "$REV" | tar -x -C "$RELEASE"
cd "$RELEASE"
npm ci --ignore-scripts
if [ "${DEPLOY_FULL_VERIFY:-0}" = "1" ]; then
  # Paranoid mode: re-run the whole suite on the host even though CI gated this commit.
  SHIELDTEST_COMMIT="$REV" SHIELDTEST_BUILD="$BUILD" npm run verify
else
  # CI already ran lint, typecheck and both suites on this exact commit. Re-running them
  # here doubled the deploy on a smaller VM and added no signal; the host only builds the
  # artifact it is about to promote.
  SHIELDTEST_COMMIT="$REV" SHIELDTEST_BUILD="$BUILD" npm run build
fi
node scripts/release-manifest.mjs
# The service may run under a different, unprivileged account. No runtime secrets are copied.
chmod -R a+rX "$RELEASE"
# Promotion is reached only after the complete gate succeeds.
DROPIN="/etc/systemd/system/${SERVICE}.service.d/40-verified-release.conf"
BACKUP="$(mktemp)"
HAD_DROPIN=0
if [ -f "$DROPIN" ]; then cat "$DROPIN" > "$BACKUP"; HAD_DROPIN=1; fi
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
sudo -n /usr/bin/mkdir -p "$(dirname "$DROPIN")"
sudo -n /usr/bin/install -m 644 "$OVERRIDE" "$DROPIN"
rollback() {
  if [ "$HAD_DROPIN" = 1 ]; then sudo -n /usr/bin/install -m 644 "$BACKUP" "$DROPIN"; else sudo -n /usr/bin/unlink "$DROPIN"; fi
  sudo -n /usr/bin/systemctl daemon-reload
  sudo -n /usr/bin/systemctl restart "$SERVICE"
}
if ! sudo -n /usr/bin/systemctl daemon-reload || ! sudo -n /usr/bin/systemctl restart "$SERVICE"; then
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
