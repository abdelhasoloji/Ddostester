#!/usr/bin/env bash
# WEDOS ShieldTest — install a GitHub Actions self-hosted runner on VPS 1 so the
# Deploy workflow updates THIS host in place (replacing the old ac02 runner).
#
# The runner runs as the service user (whose home holds the ~/ddostester clone
# the service runs from) and carries the label `vps1`, which the Deploy workflow
# now requires — so jobs land here and nowhere else. It polls GitHub outbound
# over HTTPS 443: no inbound port, the API stays loopback-only.
#
# Usage (as root on VPS 1):
#   RUNNER_TOKEN=<registration token> bash deploy/provision/host-runner.sh
#
# Get RUNNER_TOKEN from: GitHub → repo → Settings → Actions → Runners →
# "New self-hosted runner" (the token shown in the ./config.sh line; valid ~1h).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/abdelhasoloji/ddostester}"
RUNNER_USER="${RUNNER_USER:-shieldtest}"
RUNNER_LABELS="${RUNNER_LABELS:-vps1}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)}"
: "${RUNNER_TOKEN:?set RUNNER_TOKEN from GitHub repo Settings - Actions - Runners - New self-hosted runner}"

id "$RUNNER_USER" >/dev/null 2>&1 || { echo "user '$RUNNER_USER' does not exist" >&2; exit 1; }
RUNNER_HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"
RUNNER_DIR="$RUNNER_HOME/actions-runner"

# The service clone the deploy acts on must exist in the user's home.
if [ ! -d "$RUNNER_HOME/ddostester/.git" ]; then
  echo "WARNING: $RUNNER_HOME/ddostester is not a git clone — deploy/update.sh will fail" >&2
  echo "         until the service repo is cloned there (see docs/provisioning-4vps.md)." >&2
fi

echo "==> prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl tar jq >/dev/null 2>&1 || apt-get install -y -qq curl tar >/dev/null

# Resolve the latest runner version unless pinned.
VER="${RUNNER_VERSION:-}"
if [ -z "$VER" ]; then
  VER="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
        | grep -oE '"tag_name": *"v?[^"]+"' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/')"
fi
VER="${VER:-2.320.0}"
TARBALL="actions-runner-linux-x64-${VER}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${VER}/${TARBALL}"
echo "==> runner v${VER}"

echo "==> download + extract (as ${RUNNER_USER})"
mkdir -p "$RUNNER_DIR"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
sudo -u "$RUNNER_USER" bash -c "cd '$RUNNER_DIR' && curl -fsSL -o '$TARBALL' '$URL' && tar xzf '$TARBALL' && rm -f '$TARBALL'"

echo "==> configure (unattended, label '${RUNNER_LABELS}')"
sudo -u "$RUNNER_USER" bash -c "cd '$RUNNER_DIR' && ./config.sh --unattended --url '$REPO_URL' --token '$RUNNER_TOKEN' --labels '$RUNNER_LABELS' --name '$RUNNER_NAME' --replace"

echo "==> install + start as a systemd service"
( cd "$RUNNER_DIR" && ./svc.sh install "$RUNNER_USER" && ./svc.sh start )

# deploy/update.sh runs `sudo -n systemctl restart ddostester`; grant just that.
SUDOERS=/etc/sudoers.d/ddostester-deploy
if [ ! -f "$SUDOERS" ]; then
  echo "==> sudoers: allow ${RUNNER_USER} to restart the service"
  echo "${RUNNER_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart ddostester" > "$SUDOERS"
  chmod 440 "$SUDOERS"
fi

echo "==> done. Runner registered with label '${RUNNER_LABELS}'."
echo "    Verify: GitHub → repo → Settings → Actions → Runners (should show '${RUNNER_NAME}' idle)."
echo "    Then REMOVE the old ac02 runner from that same page so deploys only land here."
