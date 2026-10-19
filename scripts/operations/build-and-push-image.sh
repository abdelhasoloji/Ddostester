#!/usr/bin/env bash
# Build the worker image for a remote site, push it to a registry and print the
# immutable reference to paste into site.env.
#
#   export GHCR_USER=... GHCR_TOKEN=...        # token needs write:packages
#   ./build-and-push-image.sh --write-env deploy/kubernetes/site-worker/site.env
#
# The token is only ever fed to `docker login` on stdin; it is never echoed and
# never written to disk by this script.
set -euo pipefail

PLATFORM="linux/amd64"
TAG=""
WRITE_ENV=""
DRY_RUN=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_NAME="ddostester-lab-control"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)  PLATFORM="${2:-}"; shift 2 ;;
    --tag)       TAG="${2:-}"; shift 2 ;;
    --write-env) WRITE_ENV="${2:-}"; shift 2 ;;
    --root)      ROOT="${2:-}"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage 0 ;;
    *)           echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

[ -n "${GHCR_USER:-}" ] || { echo "FAIL: GHCR_USER is not set" >&2; exit 2; }
[ -n "${GHCR_TOKEN:-}" ] || { echo "FAIL: GHCR_TOKEN is not set (needs write:packages)" >&2; exit 2; }
command -v docker >/dev/null || { echo "FAIL: docker is not installed" >&2; exit 2; }
[ -f "$ROOT/backend/Dockerfile" ] || { echo "FAIL: $ROOT/backend/Dockerfile not found" >&2; exit 2; }
[ -d "$ROOT/.git" ] || { echo "FAIL: $ROOT is not the repository root" >&2; exit 2; }

if [ "$DRY_RUN" -eq 0 ]; then
  docker info >/dev/null 2>&1 || {
    echo "FAIL: the Docker daemon is not reachable (start Docker Desktop / dockerd)" >&2
    exit 1
  }
fi

COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
[ -n "$TAG" ] || TAG="$(git -C "$ROOT" rev-parse --short HEAD)-$(date +%Y%m%d%H%M)"
REF="ghcr.io/${GHCR_USER}/${IMAGE_NAME}:${TAG}"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN: %s\n' "$*"
  else
    "$@"
  fi
}

printf 'DRY-RUN: docker login ghcr.io -u %s --password-stdin   # token on stdin\n' "$GHCR_USER" >&2
if [ "$DRY_RUN" -eq 0 ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null ||
    { echo "FAIL: docker login refused (check the token scope)" >&2; exit 1; }
fi

run docker build --platform "$PLATFORM" -f backend/Dockerfile \
  --build-arg "SHIELDTEST_COMMIT=$COMMIT" \
  --build-arg "SHIELDTEST_BUILD=$TAG" \
  -t "$REF" "$ROOT"

run docker push "$REF"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: digest would be read from: docker inspect --format '{{index .RepoDigests 0}}' $REF"
  exit 0
fi

DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REF")"
case "$DIGEST" in
  *"@sha256:"*) ;;
  *) echo "FAIL: unexpected digest reference: $DIGEST" >&2; exit 1 ;;
esac

echo
echo "FLEET_WORKER_IMAGE=$DIGEST"
echo

if [ -n "$WRITE_ENV" ]; then
  [ -f "$WRITE_ENV" ] || { echo "FAIL: $WRITE_ENV does not exist" >&2; exit 2; }
  grep -q '^FLEET_WORKER_IMAGE=' "$WRITE_ENV" || {
    echo "FAIL: $WRITE_ENV has no FLEET_WORKER_IMAGE line" >&2
    exit 2
  }
  tmp="$(mktemp)"
  awk -v value="$DIGEST" '
    /^FLEET_WORKER_IMAGE=/ { print "FLEET_WORKER_IMAGE=" value; next }
    { print }
  ' "$WRITE_ENV" >"$tmp"
  mv "$tmp" "$WRITE_ENV"
  chmod 600 "$WRITE_ENV"
  echo "Updated $WRITE_ENV"
  echo "Next: node deploy/kubernetes/site-worker/check-render.mjs $WRITE_ENV"
fi
