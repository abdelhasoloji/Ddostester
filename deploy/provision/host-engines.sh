#!/usr/bin/env bash
# WEDOS ShieldTest — install the external load engines on VPS 1 so they show as
# INSTALLED in the app (Settings → Load engines / campaign form). They are
# optional adapters that delegate to team-operated tools; the built-in engine
# needs none of this.
#
# CRITICAL: the backend runs as user `shieldtest` with
#   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
# so every engine MUST be resolvable in /usr/local/bin. k6/vegeta are single
# static binaries (copied there); jmeter/gatling resolve their home from the
# launcher path, so we install them under /opt and drop a wrapper in
# /usr/local/bin (a symlink would break their dirname-based GATLING/JMETER_HOME).
# locust lives in a system venv, symlinked (its shebang is absolute, so that's ok).
#
# /api/agents probes availability live per request, so NO service restart is
# needed — a page reload will flip each engine to INSTALLED.
#
# Run as root on VPS 1:
#   bash host-engines.sh
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

K6_VER=0.54.0
VEGETA_VER=12.12.0
JMETER_VER=5.6.3
# Gatling ≥3.10 ships the "bundle" as a Maven project (no bin/gatling.sh); 3.9.5
# is the last standalone bundle with the classic bin/gatling.sh launcher the
# adapter expects (GATLING_BIN default 'gatling.sh').
GATLING_VER=3.9.5

case "$(uname -m)" in
  x86_64) ARCH=amd64; GARCH=x86_64 ;;
  aarch64|arm64) ARCH=arm64; GARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ok() { echo "  ✓ $1"; }
warn() { echo "  ✗ $1"; }

echo "==> base packages (jre for jmeter/gatling, venv for locust, unzip/curl)"
apt-get update -qq
apt-get install -y -qq curl ca-certificates unzip default-jre-headless python3-venv >/dev/null \
  && ok "base packages" || warn "base packages"

echo "==> k6 ${K6_VER}"
if curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VER}/k6-v${K6_VER}-linux-${ARCH}.tar.gz" \
     | tar -xz -C "$TMP" 2>/dev/null; then
  install -m 0755 "$TMP"/k6-v${K6_VER}-linux-${ARCH}/k6 /usr/local/bin/k6 && ok "k6 → /usr/local/bin/k6" || warn "k6 install"
else warn "k6 download"; fi

echo "==> vegeta ${VEGETA_VER}"
if curl -fsSL "https://github.com/tsenart/vegeta/releases/download/v${VEGETA_VER}/vegeta_${VEGETA_VER}_linux_${ARCH}.tar.gz" \
     | tar -xz -C "$TMP" vegeta 2>/dev/null; then
  install -m 0755 "$TMP/vegeta" /usr/local/bin/vegeta && ok "vegeta → /usr/local/bin/vegeta" || warn "vegeta install"
else warn "vegeta download"; fi

echo "==> locust (system venv → /usr/local/bin/locust)"
if python3 -m venv /opt/locust-venv 2>/dev/null \
   && /opt/locust-venv/bin/pip install -q --upgrade pip locust >/dev/null 2>&1; then
  ln -sf /opt/locust-venv/bin/locust /usr/local/bin/locust && ok "locust → venv symlink" || warn "locust symlink"
else warn "locust venv/pip"; fi

echo "==> jmeter ${JMETER_VER} (→ /opt + wrapper)"
if curl -fsSL "https://dlcdn.apache.org/jmeter/binaries/apache-jmeter-${JMETER_VER}.tgz" -o "$TMP/jm.tgz" 2>/dev/null \
   || curl -fsSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VER}.tgz" -o "$TMP/jm.tgz" 2>/dev/null; then
  tar -xzf "$TMP/jm.tgz" -C /opt && \
  cat > /usr/local/bin/jmeter <<EOF && chmod +x /usr/local/bin/jmeter && ok "jmeter → /opt + wrapper"
#!/usr/bin/env bash
exec /opt/apache-jmeter-${JMETER_VER}/bin/jmeter "\$@"
EOF
else warn "jmeter download"; fi

echo "==> gatling ${GATLING_VER} (→ /opt + wrapper)"
GZIP="gatling-charts-highcharts-bundle-${GATLING_VER}"
if curl -fsSL "https://repo1.maven.org/maven2/io/gatling/highcharts/gatling-charts-highcharts-bundle/${GATLING_VER}/${GZIP}-bundle.zip" -o "$TMP/gatling.zip" 2>/dev/null; then
  unzip -q -o "$TMP/gatling.zip" -d /opt && \
  cat > /usr/local/bin/gatling.sh <<EOF && chmod +x /usr/local/bin/gatling.sh && ok "gatling → /opt + wrapper"
#!/usr/bin/env bash
exec /opt/${GZIP}/bin/gatling.sh "\$@"
EOF
else warn "gatling download"; fi

echo
echo "==> verify (the exact version probe each adapter uses)"
check() { printf "  %-8s " "$1"; if timeout 60 "$@" >/dev/null 2>&1; then echo "OK (available)"; else echo "NOT available"; fi; }
check k6 version
check vegeta -version
check locust --version
check jmeter --version
check gatling.sh --help

echo
echo "==> done. /api/agents probes live — just reload the app (Settings → Load engines)."
echo "    No restart needed; the shieldtest user resolves all of these from /usr/local/bin."
