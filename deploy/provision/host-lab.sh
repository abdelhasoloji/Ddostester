#!/usr/bin/env bash
# WEDOS ShieldTest — fresh-Debian bootstrap for the ISOLATED class-C LAB host
# (VPS 2). Clones the shieldtest-lab and starts the runner that claims governed
# class-C jobs from the control plane and posts back read-only verdicts.
#
# The lab is fail-closed and egress-restricted: it must reach ONLY the control
# plane's API. It never receives inbound connections; all bench traffic stays on
# the host's internal/loopback network (no spoofing, no egress). Lock the
# firewall down separately (see docs/provisioning-4vps.md).
#
# Usage (as root on VPS 2):
#   BENCH_API_URL=https://<VPS1_PRIVATE_IP>:8080 BENCH_RUNNER_TOKEN=... \
#   bash deploy/provision/host-lab.sh
set -euo pipefail

LAB_SSH="${LAB_SSH:-https://github.com/abdelhasoloji/shieldtest-lab.git}"
LAB_DIR="${LAB_DIR:-/opt/shieldtest-lab}"
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

echo "==> clone / update shieldtest-lab"
if [ -d "$LAB_DIR/.git" ]; then
  git -C "$LAB_DIR" pull --ff-only
else
  git clone "$LAB_SSH" "$LAB_DIR"
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
ExecStart=/usr/bin/npm run runner
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now shieldtest-lab-runner.service

echo "==> done. Runner status: systemctl status shieldtest-lab-runner --no-pager"
