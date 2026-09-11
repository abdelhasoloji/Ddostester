#!/usr/bin/env bash
# WEDOS ShieldTest — IP-independent admin access via Tailscale.
#
# WHY: the VPS has no host IP allowlist (SSH key + mTLS cert are the only gates),
# but a WEDOS network-edge filter may allow only a known source IP. Tailscale is
# an OUTBOUND-initiated mesh VPN: the VPS dials out to the tailnet, so reaching it
# never depends on an inbound source-IP allowlist again. You then reach the box
# from ANY network (office, home, 4G) at its stable tailnet IP (100.x).
#
# SCOPE: this only adds a private admin path. It changes nothing about the public
# console/SSH, the allowlist, HARD_CAPS or any safeguard. Tailscale SSH is enabled
# so you can also SSH over the tailnet without managing keys.
#
# Usage (as root on the VPS):
#   bash host-tailscale.sh              # interactive: prints a login URL to open
#   TS_AUTHKEY=tskey-... bash host-tailscale.sh   # non-interactive with an auth key
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> install tailscale (official convenience script)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

systemctl enable --now tailscaled

echo "==> bring the node up (Tailscale SSH on; advertise a clear hostname)"
UP_ARGS=(--ssh --hostname=shieldtest-vps1 --accept-routes)
if [ -n "${TS_AUTHKEY:-}" ]; then
  tailscale up "${UP_ARGS[@]}" --authkey "${TS_AUTHKEY}"
else
  echo "    (interactive) open the URL below on any device logged into your tailnet:"
  tailscale up "${UP_ARGS[@]}"
fi

echo "==> done. This node's tailnet IP:"
tailscale ip -4 || true
echo "    From your laptop/phone (Tailscale app + same tailnet):"
echo "      ssh root@shieldtest-vps1            # over Tailscale SSH, no key needed"
echo "      or reach the console at https://<tailnet-ip>/ (mTLS cert still required)"
echo "    Repeat this on VPS2 (31.31.74.187) if you want tailnet access to Grafana too."
