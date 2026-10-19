#!/usr/bin/env bash
# Re-issue the fleet SERVER certificate with the SAN a remote site must validate.
#
# It never overwrites a working certificate: the new leaf is written to
# server.crt.new, verified against the existing CA, and printed for review. The CA
# and the private key are only read.
#
#   ./generate-ac02-cert.sh --pki /path/to/pki --san-ip 10.8.0.1
#   ./generate-ac02-cert.sh --pki /path/to/pki --san-ip 10.8.0.1 --san-dns fleet.example.com
#
# Then replace the fleet-server Secret (both files must come from the same issue):
#   kubectl -n ddostester-lab create secret generic fleet-server \
#     --from-file=tls.crt=.../server.crt.new \
#     --from-file=tls.key=.../server.key \
#     --from-file=ca.crt=.../ca.crt \
#     --dry-run=client -o yaml | kubectl apply -f -
set -euo pipefail

PKI=""
DAYS=14
SANS=()

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pki)      PKI="${2:-}"; shift 2 ;;
    --san-ip)   SANS+=("IP:${2:-}"); shift 2 ;;
    --san-dns)  SANS+=("DNS:${2:-}"); shift 2 ;;
    --days)     DAYS="${2:-}"; shift 2 ;;
    -h|--help)  usage 0 ;;
    *)          echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

[ -n "$PKI" ] || { echo "FAIL: --pki is required" >&2; exit 2; }
[ "${#SANS[@]}" -gt 0 ] || { echo "FAIL: at least one --san-ip or --san-dns is required" >&2; exit 2; }
[ -d "$PKI" ] || { echo "FAIL: $PKI is not a directory" >&2; exit 2; }
for file in ca.crt ca.key server.crt server.csr server.key; do
  [ -f "$PKI/$file" ] || {
    echo "FAIL: $PKI/$file is missing." >&2
    echo "This script re-issues from an EXISTING CA and refuses to create one." >&2
    exit 1
  }
done
[ "$(openssl x509 -in "$PKI/ca.crt" -noout -ext basicConstraints 2>/dev/null | grep -c 'CA:TRUE')" -ge 1 ] ||
  { echo "FAIL: $PKI/ca.crt is not a CA certificate" >&2; exit 1; }

# Preserve every SAN the current certificate already carries; add the requested
# ones. Dropping an existing name would break the lab or the local Service.
preserved=()
while IFS= read -r entry; do
  entry="$(echo "$entry" | sed 's/^ *//; s/ *$//')"
  [ -n "$entry" ] || continue
  case "$entry" in
    IP\ Address:*) preserved+=("IP:${entry#IP Address:}") ;;
    DNS:*|IP:*)    preserved+=("$entry") ;;
  esac
done < <(openssl x509 -in "$PKI/server.crt" -noout -ext subjectAltName 2>/dev/null |
  tail -n +2 | tr ',' '\n')

combined=()
for entry in "${preserved[@]}" "${SANS[@]}"; do
  seen=0
  for existing in "${combined[@]:-}"; do
    [ "$existing" = "$entry" ] && seen=1 && break
  done
  [ "$seen" -eq 0 ] && combined+=("$entry")
done

EXT="$(mktemp)"
trap 'rm -f "$EXT"' EXIT
{
  echo "basicConstraints=critical,CA:FALSE"
  echo "keyUsage=critical,digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
  echo "subjectAltName=$(IFS=,; echo "${combined[*]}")"
} >"$EXT"

SERIAL_ARGS=(-CAcreateserial)
[ -f "$PKI/ca.srl" ] && SERIAL_ARGS=(-CAserial "$PKI/ca.srl")

OUT="$PKI/server.crt.new"
openssl x509 -req -in "$PKI/server.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" \
  "${SERIAL_ARGS[@]}" -days "$DAYS" -sha256 -extfile "$EXT" -out "$OUT" 2>/dev/null
chmod 644 "$OUT"

openssl verify -CAfile "$PKI/ca.crt" -purpose sslserver "$OUT" >/dev/null ||
  { echo "FAIL: the new leaf does not verify against $PKI/ca.crt" >&2; exit 1; }

echo "OK: issued $OUT ($DAYS days), existing server.crt left untouched"
echo "SANs now:"
openssl x509 -in "$OUT" -noout -ext subjectAltName | tail -n +2 | sed 's/^ */  /'
echo
echo "Next: replace the fleet-server Secret with the new leaf, the SAME key and the CA:"
echo "  kubectl -n ddostester-lab create secret generic fleet-server \\"
echo "    --from-file=tls.crt=$OUT --from-file=tls.key=$PKI/server.key --from-file=ca.crt=$PKI/ca.crt \\"
echo "    --dry-run=client -o yaml | kubectl apply -f -"
echo "Then restart the fleet server so it reloads the certificate, and verify from the site:"
echo "  openssl s_client -connect <coordinator>:8443 -CAfile $PKI/ca.crt -servername <host>"
