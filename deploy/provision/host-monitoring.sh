#!/usr/bin/env bash
# WEDOS ShieldTest — monitoring stack on VPS 2 (fail-closed, loopback only).
# Installs node_exporter + Prometheus + Grafana (native, systemd) and points
# Prometheus at: the control-plane /metrics (reached via the existing VPS2→VPS1
# SSH tunnel on 127.0.0.1:8080) and the local node_exporter. Grafana binds
# loopback — reach it with:  ssh -L 3000:127.0.0.1:3000 root@31.31.74.187
#
# Usage (as root on VPS 2):
#   bash host-monitoring.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> packages (prometheus + node_exporter from Debian, grafana from its repo)"
apt-get update -qq
apt-get install -y -qq prometheus prometheus-node-exporter curl gnupg apt-transport-https >/dev/null

# Grafana OSS from the official repo.
if ! command -v grafana-server >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
    > /etc/apt/sources.list.d/grafana.list
  apt-get update -qq
  apt-get install -y -qq grafana >/dev/null
fi

echo "==> prometheus scrape config"
cat > /etc/prometheus/prometheus.yml <<'YML'
global:
  scrape_interval: 15s
  external_labels: { monitor: shieldtest }
scrape_configs:
  # ShieldTest control-plane (VPS 1) — reached through the existing SSH tunnel
  # that already forwards 127.0.0.1:8080 -> VPS1:8080 for the lab runner.
  - job_name: shieldtest-control-plane
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:8080']
        labels: { host: vps1, role: control-plane }
  # This host (VPS 2 — the isolated lab runner).
  - job_name: node-vps2
    static_configs:
      - targets: ['127.0.0.1:9100']
        labels: { host: vps2, role: lab-runner }
  # Prometheus itself.
  - job_name: prometheus
    static_configs:
      - targets: ['127.0.0.1:9090']
YML

echo "==> bind everything to loopback (fail-closed; reach via SSH tunnel)"
# Prometheus: listen on loopback.
if [ -f /etc/default/prometheus ]; then
  sed -i 's#^ARGS=.*#ARGS="--web.listen-address=127.0.0.1:9090"#' /etc/default/prometheus || true
  grep -q '^ARGS=' /etc/default/prometheus || echo 'ARGS="--web.listen-address=127.0.0.1:9090"' >> /etc/default/prometheus
fi
# node_exporter: loopback.
if [ -f /etc/default/prometheus-node-exporter ]; then
  sed -i 's#^ARGS=.*#ARGS="--web.listen-address=127.0.0.1:9100"#' /etc/default/prometheus-node-exporter || true
  grep -q '^ARGS=' /etc/default/prometheus-node-exporter || echo 'ARGS="--web.listen-address=127.0.0.1:9100"' >> /etc/default/prometheus-node-exporter
fi
# Grafana: loopback.
sed -i 's/^;*http_addr =.*/http_addr = 127.0.0.1/' /etc/grafana/grafana.ini || true

echo "==> enable + (re)start services"
systemctl daemon-reload
systemctl enable --now prometheus-node-exporter >/dev/null 2>&1 || systemctl restart prometheus-node-exporter
systemctl enable --now prometheus >/dev/null 2>&1 || systemctl restart prometheus
systemctl enable --now grafana-server >/dev/null 2>&1 || systemctl restart grafana-server
sleep 3

echo "==> health"
curl -fsS 127.0.0.1:9090/-/ready >/dev/null && echo "prometheus: ready" || echo "prometheus: NOT ready"
curl -fsS 127.0.0.1:9100/metrics >/dev/null && echo "node_exporter: up" || echo "node_exporter: down"
curl -fsS 127.0.0.1:3000/api/health >/dev/null && echo "grafana: up (default admin/admin — change it)" || echo "grafana: starting…"
echo "==> done. Tunnel from your Mac:  ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 root@31.31.74.187"
echo "    Then open http://localhost:3000 (Grafana) and add Prometheus datasource http://127.0.0.1:9090"
