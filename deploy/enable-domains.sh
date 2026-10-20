#!/usr/bin/env bash
# Publish the product on drs.trustena.lu (production) and testdrs.trustena.lu (staging).
#
#   sudo deploy/enable-domains.sh           # checks DNS, installs the blocks, reloads Caddy
#   sudo deploy/enable-domains.sh --check   # DNS and certificate status only
#
# The domain blocks use application authentication over TLS, not the client-certificate gate
# of the operational `:443` block: a client cannot be asked for a certificate issued by this
# estate. The IP-based mTLS vhost stays exactly as it is, so existing operational access is
# untouched.
set -euo pipefail

HOST_IP="${PUBLIC_IP:-31.31.74.228}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
MARKER='# --- DRS product domains (managed by deploy/enable-domains.sh) ---'
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: run as root.' >&2
  exit 1
fi

if ! command -v dig >/dev/null 2>&1; then
  echo 'ERROR: dig is required to verify DNS before touching Caddy.' >&2
  exit 1
fi

fail=0
for host in drs.trustena.lu testdrs.trustena.lu; do
  resolved="$(dig +short "$host" A | head -1)"
  if [ "$resolved" = "$HOST_IP" ]; then
    echo "ok    $host -> $resolved"
  else
    echo "WAIT  $host -> ${resolved:-nothing} (expected $HOST_IP)"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo
  echo 'Add these records at the DNS provider, then run this script again:'
  echo '  drs.trustena.lu.      A  '"$HOST_IP"
  echo '  testdrs.trustena.lu.  A  '"$HOST_IP"
  exit 3
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi

if ! grep -qF "$MARKER" "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d-%H%M%S)"
  cat >>"$CADDYFILE" <<EOF

$MARKER
drs.trustena.lu {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:8080
}

testdrs.trustena.lu {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:8081
}
EOF
  echo "blocks appended to $CADDYFILE"
else
  echo "blocks already present in $CADDYFILE"
fi

caddy validate --config "$CADDYFILE"
systemctl reload caddy

for pair in 'drs.trustena.lu:8080' 'testdrs.trustena.lu:8081'; do
  host="${pair%%:*}"
  local_port="${pair##*:}"
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$host/health" || true)"
    if [ "$code" = '200' ]; then
      echo "ok    https://$host/health -> 200 (backend :$local_port)"
      break
    fi
    sleep 2
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$host/health" || true)"
    if [ "$code" = '200' ]; then
      echo "ok    https://$host/health -> 200 (backend :$local_port)"
      break
    fi
  done
  [ "$code" = '200' ] || echo "WARN  https://$host/health -> ${code:-no answer}; check journalctl -u caddy"
done
