#!/usr/bin/env bash
# WEDOS ShieldTest — fresh-Debian bootstrap for the CONTROL-PLANE host (VPS 1).
#
# Idempotent OS-level prerequisites for a bare Debian 13 VPS, then it hands off
# to deploy/setup.sh (which writes the systemd unit + /etc/ddostester.env). Run
# as root. See docs/provisioning-4vps.md for the full lean (2-VPS + bank.cz) plan.
#
# Usage (as root on VPS 1):
#   ALLOWED_TARGETS=bank.cz \
#   DB_PASSWORD=... AUTH_JWT_SECRET=... BENCH_RUNNER_TOKEN=... LAB_TARGETS=lab \
#   bash deploy/provision/host-app.sh
#
# It does NOT invent secrets: pass them via env (generate with `openssl rand`).
set -euo pipefail

SVC_USER="${SVC_USER:-shieldtest}"
REPO_SSH="${REPO_SSH:-git@github.com:abdelhasoloji/Ddostester.git}"
DB_NAME="${DB_NAME:-shieldtest}"
DB_USER="${DB_USER:-shieldtest}"
: "${DB_PASSWORD:?set DB_PASSWORD}"
: "${AUTH_JWT_SECRET:?set AUTH_JWT_SECRET}"
: "${ALLOWED_TARGETS:?set ALLOWED_TARGETS (e.g. bank.cz)}"

echo "==> apt prerequisites (sudo, git, curl, postgresql, node 22)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# `sudo` is NOT present on a minimal Debian image, yet this script (and
# setup.sh) rely on `sudo -u postgres` / `sudo -u shieldtest`.
apt-get install -y -qq sudo git curl ca-certificates postgresql >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> local Postgres role + database (idempotent)"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -qc "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -qc "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "==> service user + repo clone"
SVC_HOME="/home/$SVC_USER"
# `adduser --system` defaults the home to /nonexistent, which the git clone
# below cannot write to — pin a real, writable home (and shell).
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  adduser --system --home "$SVC_HOME" --shell /bin/bash --group "$SVC_USER"
fi
# Repair a service user created earlier with an unusable home, moving any
# existing .ssh (its deploy key) so it stays valid.
CUR_HOME="$(getent passwd "$SVC_USER" | cut -d: -f6)"
if [ "$CUR_HOME" != "$SVC_HOME" ]; then
  mkdir -p "$SVC_HOME"
  if [ -d "$CUR_HOME/.ssh" ] && [ ! -d "$SVC_HOME/.ssh" ]; then mv "$CUR_HOME/.ssh" "$SVC_HOME/.ssh"; fi
  usermod -d "$SVC_HOME" "$SVC_USER"
  chown -R "$SVC_USER:$SVC_USER" "$SVC_HOME"
fi
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$SVC_HOME/.ssh"
if [ ! -f "$SVC_HOME/.ssh/id_ed25519" ]; then
  sudo -u "$SVC_USER" ssh-keygen -t ed25519 -f "$SVC_HOME/.ssh/id_ed25519" -N "" -q
  echo "!! Add this as a READ-ONLY deploy key on the repo, then re-run:"
  cat "$SVC_HOME/.ssh/id_ed25519.pub"; exit 1
fi
sudo -u "$SVC_USER" ssh-keyscan -t ed25519 github.com >> "$SVC_HOME/.ssh/known_hosts" 2>/dev/null || true
if [ ! -d "$SVC_HOME/ddostester/.git" ]; then
  sudo -u "$SVC_USER" git clone "$REPO_SSH" "$SVC_HOME/ddostester"
fi

echo "==> hand off to deploy/setup.sh (writes systemd unit + /etc/ddostester.env)"
DATABASE_URL="${DATABASE_URL:-postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}}" \
  bash "$SVC_HOME/ddostester/deploy/setup.sh"

echo "==> done. Verify: curl -s localhost:${PORT:-8080}/health"
