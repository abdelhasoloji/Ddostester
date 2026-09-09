#!/usr/bin/env bash
# ShieldTest mTLS PKI — an internal CA, a server cert for the VPS, and one
# client cert per admin. Run on a SECURE workstation (NOT the public VPS).
#
# Nothing here is committed: the output dir is gitignored and the keys stay
# local. Copy only what each host needs (see the summary printed at the end).
#
# Usage:
#   SERVER_CN=shieldtest.example CLIENTS="alice bob" bash deploy/proxy/make-ca-certs.sh
#   # SERVER_CN may be a public IP too, e.g. SERVER_CN=203.0.113.10
set -euo pipefail

OUT="${OUT:-./shieldtest-pki}"
: "${SERVER_CN:?set SERVER_CN (the domain or public IP clients will connect to)}"
CLIENTS="${CLIENTS:-admin1}"     # space-separated admin names → one client cert each
DAYS="${DAYS:-825}"              # leaf-cert lifetime (≤825d = browser-friendly)

mkdir -p "$OUT"; cd "$OUT"
umask 077                        # keys are created private

# 1) Internal CA. Keep ca.key OFFLINE (password manager / HSM) after this run.
if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
    -subj "/CN=ShieldTest Internal CA" -out ca.crt
fi

# 2) Server certificate (SAN = SERVER_CN; IP vs DNS auto-detected).
if [[ "$SERVER_CN" =~ ^[0-9.]+$ ]]; then SAN="IP:$SERVER_CN"; else SAN="DNS:$SERVER_CN"; fi
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=$SERVER_CN" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -sha256 \
  -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$SAN") \
  -out server.crt

# 3) Client certificates — one .p12 per admin (import into browser / OS keychain).
for c in $CLIENTS; do
  openssl genrsa -out "client-$c.key" 2048
  openssl req -new -key "client-$c.key" -subj "/CN=$c" -out "client-$c.csr"
  openssl x509 -req -in "client-$c.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS" -sha256 \
    -extfile <(printf 'extendedKeyUsage=clientAuth\n') -out "client-$c.crt"
  # Empty export password for convenience; set -passout pass:... to protect it.
  openssl pkcs12 -export -inkey "client-$c.key" -in "client-$c.crt" -certfile ca.crt \
    -passout pass: -out "client-$c.p12"
done
rm -f ./*.csr ./*.srl

echo
echo "PKI written to $OUT:"
echo "  → to the VPS (/etc/shieldtest/tls/):  server.crt  server.key  ca.crt"
echo "  → to each admin:                       client-<name>.p12 (import in browser)"
echo "  → keep OFFLINE:                        ca.key  (never copy to the VPS)"
