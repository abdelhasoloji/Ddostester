#!/usr/bin/env bash
# WEDOS ShieldTest — fresh-Debian bootstrap for the ISOLATED class-C LAB host
# (VPS 2). Clones the shieldtest-lab and starts the runner that claims governed
# class-C jobs from the control plane and posts back read-only verdicts.
#
# The lab is fail-closed and egress-restricted: it must reach ONLY the control
# plane's API. It never receives inbound connections; all bench traffic stays on
# the host's internal/loopback network (no spoofing, no egress).
#
# Usage (as root on VPS 2):
#   BENCH_API_URL=http://<VPS1_IP>:8080 BENCH_RUNNER_TOKEN=... \
#   LAB_SSH=git@github.com:abdelhasoloji/shieldtest-lab.git \
#   bash deploy/provision/host-lab.sh
#
# shieldtest-lab is PRIVATE, so this host needs read access. Provide EITHER:
#   • a read-only Deploy key + LAB_SSH=git@github.com:owner/repo.git (preferred), OR
#   • GIT_PAT=<fine-grained PAT, read on shieldtest-lab> (used only for the clone,
#     never written to the unit file, and scrubbed from the remote afterwards).
#
# Optional firewall lockdown (applied AFTER the clone, since the clone needs
# GitHub egress): LOCK_FIREWALL=1 ADMIN_IP=<your mgmt IP>. Derives the control
# plane host:port from BENCH_API_URL.
set -euo pipefail

LAB_SSH="${LAB_SSH:-https://github.com/abdelhasoloji/shieldtest-lab.git}"
LAB_DIR="${LAB_DIR:-/opt/shieldtest-lab}"
RUNNER_ID="${RUNNER_ID:-$(hostname)}"
: "${BENCH_API_URL:?set BENCH_API_URL (the control-plane API base)}"
: "${BENCH_RUNNER_TOKEN:?set BENCH_RUNNER_TOKEN (must match the control plane)}"

echo "==> apt prerequisites (git, curl, node 22)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> clone / update shieldtest-lab (private repo)"
clone_url="$LAB_SSH"
scrub_remote=0
if [ -n "${GIT_PAT:-}" ]; then
  clone_url="https://x-access-token:${GIT_PAT}@github.com/abdelhasoloji/shieldtest-lab.git"
  scrub_remote=1
fi
if [ -d "$LAB_DIR/.git" ]; then
  git -C "$LAB_DIR" pull --ff-only
else
  if ! git clone "$clone_url" "$LAB_DIR"; then
    cat >&2 <<'HINT'
!! Clone failed. shieldtest-lab is PRIVATE — VPS 2 needs read access. Either:
   • add a read-only Deploy key (ssh-keygen here, add the .pub to the repo's
     Deploy keys) and re-run with
       LAB_SSH=git@github.com:abdelhasoloji/shieldtest-lab.git
   • or re-run with GIT_PAT=<fine-grained PAT, read on shieldtest-lab>.
HINT
    exit 1
  fi
  # Never leave a PAT embedded in the on-disk git remote.
  if [ "$scrub_remote" = 1 ]; then
    git -C "$LAB_DIR" remote set-url origin \
      https://github.com/abdelhasoloji/shieldtest-lab.git
  fi
fi

# The lab has no npm dependencies (pure Node builtins); install only if that
# ever changes, so the runner always has what it needs.
if [ -f "$LAB_DIR/package.json" ] && grep -q '"dependencies"' "$LAB_DIR/package.json"; then
  echo "==> npm ci (dependencies present)"
  (cd "$LAB_DIR" && npm ci --omit=dev >/dev/null)
fi

echo "==> install a systemd unit for the runner (survives reboots)"
cat > /etc/systemd/system/shieldtest-lab-runner.service <<UNIT
[Unit]
Description=WEDOS ShieldTest — isolated class-C lab runner
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${LAB_DIR}
Environment=BENCH_API_URL=${BENCH_API_URL}
Environment=BENCH_RUNNER_TOKEN=${BENCH_RUNNER_TOKEN}
Environment=RUNNER_ID=${RUNNER_ID}
ExecStart=/usr/bin/npm run runner
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 /etc/systemd/system/shieldtest-lab-runner.service  # unit carries the bearer token
systemctl daemon-reload
systemctl enable --now shieldtest-lab-runner.service

if [ "${LOCK_FIREWALL:-0}" = "1" ]; then
  : "${ADMIN_IP:?set ADMIN_IP (your management address) to keep SSH open}"
  # Derive control-plane host:port from BENCH_API_URL (e.g. http://31.31.74.228:8080).
  hostport="${BENCH_API_URL#*://}"; hostport="${hostport%%/*}"
  cp_ip="${hostport%%:*}"
  cp_port="${hostport##*:}"; [ "$cp_port" = "$hostport" ] && cp_port=8080
  echo "==> locking firewall: allow SSH from ${ADMIN_IP}, egress only to ${cp_ip}:${cp_port} + DNS"
  apt-get install -y -qq ufw >/dev/null
  ufw default deny incoming
  ufw default deny outgoing
  ufw allow from "$ADMIN_IP" to any port 22 proto tcp
  ufw allow out to "$cp_ip" port "$cp_port" proto tcp
  ufw allow out 53
  ufw --force enable
fi

echo "==> done. Runner status: systemctl status shieldtest-lab-runner --no-pager"
echo "    Logs:            journalctl -u shieldtest-lab-runner -n 30 --no-pager"
