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
# The host resolver keeps the old wildcard cached for the TTL; the public view is what clients
# and Let's Encrypt will see, so verification asks a public resolver.
DNS_RESOLVER="${DNS_RESOLVER:-@1.1.1.1}"
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

ready=()
pending=()
for host in drs.trustena.lu testdrs.trustena.lu; do
  resolved="$(dig +short "$DNS_RESOLVER" "$host" A | head -1)"
  if [ "$resolved" = "$HOST_IP" ]; then
    echo "ok    $host -> $resolved"
    ready+=("$host")
  else
    echo "WAIT  $host -> ${resolved:-nothing} (expected $HOST_IP)"
    pending+=("$host")
  fi
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  [ "${#pending[@]}" -eq 0 ] || exit 3
  exit 0
fi

if [ "${#ready[@]}" -eq 0 ]; then
  echo
  echo 'No name points here yet. Add these records at the DNS provider:'
  echo '  drs.trustena.lu.      A  '"$HOST_IP"
  echo '  testdrs.trustena.lu.  A  '"$HOST_IP"
  exit 3
fi

# One block per name that resolves; a name that does not is left for the next run rather
# than making the whole activation wait.
block_for() {
  local host="$1" port="$2" hsts='max-age=31536000'
  [ "$host" = 'drs.trustena.lu' ] && hsts='max-age=31536000; includeSubDomains'
  cat <<EOF

$host {
	encode gzip
	header {
		Strict-Transport-Security "$hsts"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:$port
}
EOF
}

cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d-%H%M%S)"

# The internal vhost was written as `:443`, a catch-all: it also answered the product names
# and served its own certificate for them (TLS selects by SNI, and the site had no name).
# Scope it to the address clients actually use, so each product name keeps its own cert and
# a connection without SNI still gets the internal one.
if grep -qE '^:443 \{' "$CADDYFILE"; then
  sed -i "s|^:443 {|https://$HOST_IP {|" "$CADDYFILE"
  echo "internal vhost scoped to https://$HOST_IP"
fi

added=0
for host in "${ready[@]}"; do
  if grep -qE "^${host} \{" "$CADDYFILE"; then
    echo "blocks already present for $host"
    continue
  fi
  case "$host" in
    drs.trustena.lu) block_for "$host" 8080 >>"$CADDYFILE" ;;
    testdrs.trustena.lu) block_for "$host" 8081 >>"$CADDYFILE" ;;
  esac
  added=$((added + 1))
done
[ "$added" -gt 0 ] && echo "$added block(s) appended to $CADDYFILE"

caddy validate --config "$CADDYFILE"
systemctl reload caddy

for host in "${ready[@]}"; do
  case "$host" in
    drs.trustena.lu) local_port=8080 ;;
    testdrs.trustena.lu) local_port=8081 ;;
  esac
  # /health says the API is up; / says the product is served. Staging once answered 200 on
  # /health and 404 on / because only the backend had been built, so both are checked.
  health=''
  root=''
  serve=''
  for _ in $(seq 1 30); do
    health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$host:443:$HOST_IP" "https://$host/health" || true)"
    serve="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$host:443:$HOST_IP" "https://$host/" || true)"
    [ "$health" = '200' ] && [ "$serve" = '200' ] && break
    sleep 2
  done
  root="$(curl -s --max-time 5 --resolve "$host:443:$HOST_IP" "https://$host/" | grep -c '<title>' || true)"
  if [ "$health" = '200' ] && [ "$serve" = '200' ] && [ "$root" -gt 0 ]; then
    echo "ok    https://$host -> 200 (/health and / with title, backend :$local_port)"
  else
    echo "WARN  https://$host -> health=${health:-none} root=${serve:-none} title=${root:-0}; check journalctl -u caddy and the service"
  fi
done

if [ "${#pending[@]}" -gt 0 ]; then
  echo
  echo "Still waiting on DNS (run again later): ${pending[*]}"
fi
