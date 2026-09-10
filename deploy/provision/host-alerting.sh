#!/usr/bin/env bash
# WEDOS ShieldTest — alerting on VPS 2 (fail-closed, loopback only).
# Installs Alertmanager, wires Prometheus -> Alertmanager, ships a rule set that
# turns the ShieldTest metrics into actionable alerts, and (optionally) forwards
# to Rocket.Chat. Everything binds 127.0.0.1 — reach the UIs via SSH tunnel.
#
# Usage (as root on VPS 2):
#   RC_WEBHOOK='https://chat.example/hooks/XXXX/YYYY' bash host-alerting.sh
#   # RC_WEBHOOK is optional: without it alerts still fire and are visible in the
#   # Alertmanager UI (ssh -L 9093:127.0.0.1:9093 root@31.31.74.187) — they just
#   # aren't pushed to chat. Re-run with RC_WEBHOOK set to enable the push.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
RC_WEBHOOK="${RC_WEBHOOK:-}"

echo "==> package (alertmanager from Debian)"
apt-get update -qq
apt-get install -y -qq prometheus-alertmanager >/dev/null

echo "==> alert rules (/etc/prometheus/alert.rules.yml)"
cat > /etc/prometheus/alert.rules.yml <<'YML'
groups:
  - name: shieldtest
    rules:
      # --- Test <-> protection signal (the product-level ones) ---
      - alert: TargetTarpittingRuns
        expr: increase(shieldtest_loadtest_hard_stopped_total[15m]) > 0
        for: 0m
        labels: { severity: warning }
        annotations:
          summary: "Target {{ $labels.target }} tarpitting our runs"
          description: "{{ $value }} run(s) force-settled by the hard backstop in 15m — the edge held connections past the cap (protection biting)."

      - alert: WRSDrop
        expr: shieldtest_run_wrs_last < 70
        for: 0m
        labels: { severity: warning }
        annotations:
          summary: "WRS dropped for {{ $labels.target }} ({{ $value }})"
          description: "Last WEDOS Resilience Score for {{ $labels.target }} fell below 70 — protection may be degraded, or a template is misbehaving."

      - alert: ProtectionNotEngaging
        expr: shieldtest_run_absorbed_ratio_last < 0.05
        for: 0m
        labels: { severity: info }
        annotations:
          summary: "Edge absorbed <5% for {{ $labels.target }}"
          description: "Absorbed ratio {{ $value }} — almost all offered load reached origin. Either protection isn't engaging, or the run stayed under thresholds (expected for low-rate templates)."

      - alert: CampaignRunsFailing
        expr: increase(shieldtest_runs_completed_total{status="failed"}[15m]) > 0
        for: 0m
        labels: { severity: warning }
        annotations:
          summary: "A campaign run failed"
          description: "{{ $value }} run(s) ended status=failed in the last 15m — a template may be broken or the target unreachable."

      # --- Control-plane self-health (is VPS1 the bottleneck, not the target?) ---
      - alert: ControlPlaneEventLoopLag
        expr: shieldtest_eventloop_lag_p99_ms > 200
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Control-plane event-loop p99 lag high ({{ $value }}ms)"
          description: "VPS1 event loop is stalling for >5m — the generator host may be the bottleneck, so WRS/achieved-RPS could be understated."

      - alert: RunsInFlightSaturated
        expr: shieldtest_runs_in_flight >= 5
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $value }} runs in flight for >10m"
          description: "Sustained concurrent runs — check capacity/scheduling on VPS1."

      # --- Scrape liveness ---
      - alert: ControlPlaneDown
        expr: up{job="shieldtest-control-plane"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "Control-plane /metrics unreachable"
          description: "Prometheus can't scrape VPS1:8080 via the tunnel for >2m — app down or tunnel broken."

      - alert: MonitoringTargetDown
        expr: up == 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Scrape target down: {{ $labels.job }}"
          description: "{{ $labels.job }} ({{ $labels.instance }}) has been unreachable for >5m."
YML
promtool check rules /etc/prometheus/alert.rules.yml

echo "==> alertmanager config (loopback; Rocket.Chat receiver if RC_WEBHOOK set)"
if [ -n "$RC_WEBHOOK" ]; then
  RECEIVER_BLOCK=$(cat <<RCV
  - name: rocketchat
    slack_configs:
      - api_url: '${RC_WEBHOOK}'
        channel: '#shieldtest-alerts'
        send_resolved: true
        title: '{{ .Status | toUpper }} — {{ .CommonLabels.alertname }}'
        text: >-
          {{ range .Alerts }}*{{ .Annotations.summary }}*
          {{ .Annotations.description }}
          {{ end }}
RCV
)
  DEFAULT_RECEIVER=rocketchat
else
  RECEIVER_BLOCK=$'  - name: rocketchat'   # empty receiver: alerts fire, visible in UI, no push
  DEFAULT_RECEIVER=rocketchat
fi
cat > /etc/alertmanager/alertmanager.yml <<YML
route:
  receiver: ${DEFAULT_RECEIVER}
  group_by: ['alertname', 'target']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [ severity="critical" ]
      repeat_interval: 1h
receivers:
${RECEIVER_BLOCK}
inhibit_rules:
  - source_matchers: [ severity="critical" ]
    target_matchers: [ severity="warning" ]
    equal: ['alertname', 'target']
YML
amtool check-config /etc/alertmanager/alertmanager.yml 2>/dev/null || true

echo "==> bind alertmanager to loopback"
if [ -f /etc/default/prometheus-alertmanager ]; then
  sed -i 's#^ARGS=.*#ARGS="--web.listen-address=127.0.0.1:9093 --cluster.listen-address="#' /etc/default/prometheus-alertmanager || true
  grep -q '^ARGS=' /etc/default/prometheus-alertmanager || echo 'ARGS="--web.listen-address=127.0.0.1:9093 --cluster.listen-address="' >> /etc/default/prometheus-alertmanager
fi

echo "==> wire Prometheus -> rules + alertmanager (idempotent append)"
if ! grep -q 'alert.rules.yml' /etc/prometheus/prometheus.yml; then
  cat >> /etc/prometheus/prometheus.yml <<'YML'

# --- added by host-alerting.sh ---
rule_files:
  - /etc/prometheus/alert.rules.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['127.0.0.1:9093']
YML
fi
promtool check config /etc/prometheus/prometheus.yml

echo "==> enable + restart"
systemctl daemon-reload
systemctl enable prometheus-alertmanager >/dev/null 2>&1 || true
systemctl restart prometheus-alertmanager
systemctl restart prometheus
sleep 3

echo "==> health"
curl -fsS 127.0.0.1:9093/-/ready >/dev/null 2>&1 && echo "alertmanager: ready" || echo "alertmanager: NOT ready"
curl -fsS 127.0.0.1:9090/-/ready >/dev/null 2>&1 && echo "prometheus:   ready" || echo "prometheus:   NOT ready"
echo -n "active rules loaded: "; curl -fsS 127.0.0.1:9090/api/v1/rules 2>/dev/null | grep -o '"name"' | wc -l
echo
echo "==> done."
echo "    Alertmanager UI:  ssh -L 9093:127.0.0.1:9093 root@31.31.74.187  then http://localhost:9093"
[ -z "$RC_WEBHOOK" ] && echo "    NOTE: no RC_WEBHOOK set — re-run with it to push alerts to Rocket.Chat."
