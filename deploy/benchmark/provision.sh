#!/usr/bin/env bash
# WEDOS ShieldTest — provision the bare-origin BENCHMARK (VPS3) reproducibly.
#
# This is the deliberately-UNPROTECTED origin that a protected edge is measured
# against: no WAF, no CDN, no rate limiting, a tiny PHP-FPM pool, and generous
# timeouts. It is NOT attack code — it is the victim/target app, so the control
# plane's scenarios have something with real, exploitable weaknesses to measure.
# Every dynamic endpoint's per-request cost is bounded (<=2s), so the box
# degrades and recovers under a bounded load test instead of hanging forever.
#
# Weaknesses it exposes (each maps to a recon posture flag the playbooks gate on):
#   dynamic  — the homepage links expensive PHP endpoints (search/db/report/
#              login), so recon discovers them and origin-exhaustion lands;
#   h2       — real TLS+HTTP/2 on :443 (self-signed) + an Alt-Svc header on :80;
#   cache    — the root emits X-Cache/Age/Cache-Control so recon reads cache=hit;
#   (waf     — intentionally absent: a bare origin has no WAF to evade.)
# The real exhaustion lever is pm.max_children=5: a handful of the expensive
# endpoints in flight saturates every worker and nginx starts returning 502/504.
#
# Usage (as root on the benchmark host):
#   GENERATOR_IP=31.31.74.228 bash deploy/benchmark/provision.sh
#
# GENERATOR_IP is the control-plane generator/recon source (VPS1). The firewall
# is locked so ONLY that host can reach :80/:443 — a deliberately-exhaustible
# origin must never be left open to the internet. Pass PUBLIC_HTTP=1 to also
# allow :80 from anywhere (a public demo; NOT recommended once weakened).
set -euo pipefail

GENERATOR_IP="${GENERATOR_IP:-31.31.74.228}"
DOCROOT="${DOCROOT:-/var/www/benchmark}"
PHP_VER="${PHP_VER:-8.4}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> packages (nginx, php-fpm, openssl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx "php${PHP_VER}-fpm" openssl >/dev/null

FPM_SOCK="/run/php/php${PHP_VER}-fpm.sock"

echo "==> web files -> ${DOCROOT}"
install -d -o www-data -g www-data "${DOCROOT}/api"
cp -f "${SRC}/www/index.html"  "${DOCROOT}/index.html"
cp -f "${SRC}/www/login.php"   "${DOCROOT}/login.php"
cp -f "${SRC}/www/account.php" "${DOCROOT}/account.php"
cp -f "${SRC}"/www/api/*.php   "${DOCROOT}/api/"
# Drop the default landing page if the distro left one.
rm -f "${DOCROOT}/index.nginx-debian.html"
chown -R www-data:www-data "${DOCROOT}"
chmod -R a+rX "${DOCROOT}"

echo "==> PHP-FPM pool: small + shallow backlog, so exhaustion is a fast 5xx wall"
POOL="/etc/php/${PHP_VER}/fpm/pool.d/www.conf"
if [ -f "$POOL" ]; then
  sed -i -E 's/^;?\s*pm\.max_children\s*=.*/pm.max_children = 5/' "$POOL"
  # A shallow listen backlog is the drama lever: once the 5 workers are busy,
  # excess connections are refused immediately, so nginx returns 502 right away
  # (a visible wall of 5xx) instead of letting requests pile into slow, invisible
  # timeouts. That, plus the short fastcgi_read_timeout in the vhost, makes an
  # origin-exhaustion run collapse the origin flagrantly and fast.
  if grep -qE '^;?\s*listen\.backlog' "$POOL"; then
    sed -i -E 's/^;?\s*listen\.backlog\s*=.*/listen.backlog = 16/' "$POOL"
  else
    printf '\nlisten.backlog = 16\n' >>"$POOL"
  fi
fi

echo "==> self-signed cert for TLS+HTTP/2 on :443"
install -d /etc/ssl/benchmark
if [ ! -s /etc/ssl/benchmark/benchmark.crt ]; then
  IP="$(hostname -I | awk '{print $1}')"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/ssl/benchmark/benchmark.key \
    -out    /etc/ssl/benchmark/benchmark.crt \
    -days 825 -subj "/CN=${IP}" -addext "subjectAltName=IP:${IP}" 2>/dev/null
  chmod 600 /etc/ssl/benchmark/benchmark.key
fi

echo "==> nginx vhost"
# The vhost pins the FPM socket for the current PHP version.
sed "s#unix:/run/php/php8.4-fpm.sock#unix:${FPM_SOCK}#g" \
  "${SRC}/benchmark.nginx" > /etc/nginx/sites-available/benchmark
ln -sf /etc/nginx/sites-available/benchmark /etc/nginx/sites-enabled/benchmark
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx "php${PHP_VER}-fpm" >/dev/null 2>&1 || true
systemctl reload nginx
systemctl restart "php${PHP_VER}-fpm"

echo "==> firewall: :80/:443 reachable ONLY from the generator (${GENERATOR_IP})"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow from "${GENERATOR_IP}" to any port 80  proto tcp >/dev/null 2>&1 || true
  ufw allow from "${GENERATOR_IP}" to any port 443 proto tcp >/dev/null 2>&1 || true
  if [ "${PUBLIC_HTTP:-0}" = "1" ]; then
    echo "    PUBLIC_HTTP=1 → also allowing :80 from anywhere (public demo)"
    ufw allow 80/tcp >/dev/null 2>&1 || true
  fi
  ufw --force enable >/dev/null 2>&1 || true
else
  echo "    ufw not installed — skipping firewall (LOCK :80/:443 to the generator manually!)"
fi

echo "==> smoke test"
for u in "/" "/api/search.php?q=widget&rows=2000" "/api/report.php?ms=100" \
         "/api/cached.php" "/login.php"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1${u}" || echo ERR)"
  echo "    GET ${u} -> ${code}"
done
echo "    Alt-Svc:"; curl -sI "http://127.0.0.1/" | grep -i alt-svc || echo "    (missing!)"
echo "    h2/TLS:"; curl -sk --http2 -o /dev/null -w '    negotiated http/%{http_version}\n' "https://127.0.0.1/" || true
echo "==> done. Weakened benchmark provisioned at ${DOCROOT}."
