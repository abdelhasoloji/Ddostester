#!/usr/bin/env bash
# WEDOS ShieldTest — central log aggregation (Loki) on VPS 2 (loopback only).
# Installs Loki + Promtail (Grafana release binaries, no apt repo needed) and adds
# a Loki datasource to Grafana so logs sit next to metrics in one pane.
#
# SCOPE: Promtail here scrapes THIS host's (VPS2) journald. The control-plane
# run.start/run.settled logs live on VPS1's journal — to ship those into this
# Loki, run a second Promtail ON VPS1 with a `clients.url` of
# http://127.0.0.1:<p>/loki/api/v1/push over a VPS1→VPS2:3100 SSH tunnel (same
# reverse-tunnel pattern as the edge). That VPS1 leg is a documented follow-up;
# this script stands up the Loki backend + Grafana wiring first.
#
# Everything binds 127.0.0.1 — reach Grafana via the existing SSH tunnel.
#
# Usage (as root on VPS 2):
#   GRAFANA_PASS='your-grafana-admin-password' bash host-loki.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
LOKI_VER="${LOKI_VER:-3.2.1}"
GRAFANA_PASS="${GRAFANA_PASS:-}"

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

echo "==> deps (unzip, curl)"
apt-get update -qq
apt-get install -y -qq unzip curl >/dev/null

echo "==> Loki + Promtail ${LOKI_VER} binaries -> /usr/local/bin"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for bin in loki promtail; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    curl -fsSL "https://github.com/grafana/loki/releases/download/v${LOKI_VER}/${bin}-linux-${ARCH}.zip" -o "$TMP/${bin}.zip"
    unzip -q -o "$TMP/${bin}.zip" -d "$TMP"
    install -m 0755 "$TMP/${bin}-linux-${ARCH}" "/usr/local/bin/${bin}"
  fi
done

echo "==> loki config (single-binary, filesystem, loopback :3100)"
mkdir -p /etc/loki /var/lib/loki
cat > /etc/loki/loki.yml <<'YML'
auth_enabled: false
server:
  http_listen_address: 127.0.0.1
  http_listen_port: 3100
  grpc_listen_address: 127.0.0.1
common:
  instance_addr: 127.0.0.1
  path_prefix: /var/lib/loki
  storage:
    filesystem:
      chunks_directory: /var/lib/loki/chunks
      rules_directory: /var/lib/loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2020-10-24
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  retention_period: 336h
YML

echo "==> promtail config (scrape THIS host's journald -> Loki)"
mkdir -p /etc/promtail /var/lib/promtail
cat > /etc/promtail/promtail.yml <<'YML'
server:
  http_listen_address: 127.0.0.1
  http_listen_port: 9080
positions:
  filename: /var/lib/promtail/positions.yml
clients:
  - url: http://127.0.0.1:3100/loki/api/v1/push
scrape_configs:
  - job_name: journal
    journal:
      max_age: 12h
      labels:
        host: vps2
        job: journal
    relabel_configs:
      - source_labels: ['__journal__systemd_unit']
        target_label: unit
      - source_labels: ['__journal_syslog_identifier']
        target_label: ident
YML

echo "==> systemd units"
cat > /etc/systemd/system/loki.service <<'UNIT'
[Unit]
Description=Loki log aggregation
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/loki -config.file=/etc/loki/loki.yml
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/promtail.service <<'UNIT'
[Unit]
Description=Promtail journald shipper
After=loki.service
Wants=loki.service
[Service]
# root so it can read the systemd journal
ExecStart=/usr/local/bin/promtail -config.file=/etc/promtail/promtail.yml
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

echo "==> enable + start"
systemctl daemon-reload
for svc in loki promtail; do
  systemctl enable "$svc" >/dev/null 2>&1 || true
  systemctl restart "$svc"
done
sleep 4

echo "==> health"
curl -fsS 127.0.0.1:3100/ready >/dev/null 2>&1 && echo "loki: ready" || echo "loki: starting…"
curl -fsS 127.0.0.1:9080/ready >/dev/null 2>&1 && echo "promtail: ready" || echo "promtail: starting…"

echo "==> add Loki datasource to Grafana"
if [ -n "$GRAFANA_PASS" ]; then
  AUTH="admin:${GRAFANA_PASS}"
  EXIST=$(curl -fsS -u "$AUTH" http://127.0.0.1:3000/api/datasources 2>/dev/null | grep -c '"type":"loki"' || true)
  if [ "${EXIST:-0}" = "0" ]; then
    curl -fsS -u "$AUTH" -H 'content-type: application/json' \
      -d '{"name":"Loki","type":"loki","access":"proxy","url":"http://127.0.0.1:3100"}' \
      http://127.0.0.1:3000/api/datasources >/dev/null 2>&1 && echo "grafana: Loki datasource added" \
      || echo "grafana: datasource add failed (check GRAFANA_PASS)"
  else
    echo "grafana: Loki datasource already present"
  fi
else
  echo "grafana: set GRAFANA_PASS to auto-add the Loki datasource (or add http://127.0.0.1:3100 by hand)"
fi

echo "==> done. Explore logs in Grafana → Explore → Loki, e.g.  {job=\"journal\",unit=\"ddostester.service\"} |= \"run.settled\""
echo "    Correlate a metric spike to its run:  {unit=\"ddostester.service\"} | json | runId=\`<id>\`"
