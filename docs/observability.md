# Observability and evidence provenance

The API exposes Prometheus `/metrics`, structured run lifecycle/error logs, audit, campaign/run progress and diagnostic exports. The UI provides Run Theater charts and a compact live Fleet count; per-agent receipts belong to Fleet. Data gaps are shown as unknown rather than healthy/zero.

`deploy/monitoring/` contains control-plane dashboards/rules; `deploy/kubernetes/monitoring/` contains the private HTTP-lab Prometheus/Grafana manifests and rule tests. The separate synthetic bench has its own metrics/monitoring stack. Provider configuration, scrape success and independent DRS measurement are different facts.

Production health reports the configured protection provider, target-telemetry/remote-probe flags and build identity. The dated Linux lab observation has private Prometheus/Grafana Pods. See [current setup](current-setup.md); copied old host/provisioning statuses are not live checks.

For meaningful DRS evidence, declare four instrument roles, separate user-probe resources/connections, units, frequency/clock uncertainty, actual entry load, functional journeys, recovery and calibration. Preserve raw artifact hashes, gaps and provenance. Legacy estimate fallback must remain labelled; a configured protection provider cannot establish full physical qualification.

Operational scripts support backup freshness, restore and audit witness workflows. Alert/witness destinations and retention are operator-owned; repository templates do not prove continuous operation. Notification webhooks are optional runtime configuration; avoid logging credentials or confidential payloads.

See [measurement](measurement.md), [DRS engine](drs-engine.md), [operations](operations.md) and [testing](testing.md).
