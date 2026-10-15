# Observability and evidence provenance

The API exposes Prometheus `/metrics`, structured run lifecycle/error logs, audit, campaign/run progress and diagnostic exports. The UI provides Run Theater charts and a compact live Fleet count; per-agent receipts belong to Fleet. Data gaps are shown as unknown rather than healthy/zero.

`deploy/monitoring/` contains control-plane dashboards/rules; `deploy/kubernetes/monitoring/` contains the private HTTP-lab Prometheus/Grafana manifests and rule tests. The separate synthetic bench has its own metrics/monitoring stack. Provider configuration, scrape success and independent DRS measurement are different facts.

Production health reports the configured protection provider, target-telemetry/remote-probe flags and build identity. The dated Linux lab observation has private Prometheus/Grafana Pods. See [current setup](current-setup.md); copied old host/provisioning statuses are not live checks.

For meaningful DRS evidence, declare four instrument roles, separate user-probe resources/connections, units, frequency/clock uncertainty, actual entry load, functional journeys, recovery and calibration. Preserve raw artifact hashes, gaps and provenance. Legacy estimate fallback must remain labelled; a configured protection provider cannot establish full physical qualification.

Operational scripts support backup freshness, restore and audit witness workflows. Alert/witness destinations and retention are operator-owned; repository templates do not prove continuous operation. Notification webhooks are optional runtime configuration; avoid logging credentials or confidential payloads.

See [measurement](measurement.md), [DRS engine](drs-engine.md), [operations](operations.md) and [testing](testing.md).

## HTTP target receipt collector

The dedicated HTTP target sidecar now exposes Prometheus text at `:9101/metrics` alongside its existing JSON receipt API. The monitoring overlay adds a five-second target scrape, explicit Prometheus-to-receipts policy and a `shieldtest-http-receipts` dashboard. This is target-side receipt instrumentation, not a new generator or a measured protection verdict. Runtime rollout and source-image identity require their own receipt.

`shieldtest_http_target_received_requests_total` is scoped by campaign ID, run ID and target Pod UID; it counts only tagged requests actually present in the target log. Collector continuity, log availability, process start and successful log-read time are separate metrics. Empty buckets remain absent. Missing logs, partial lines, file replacement, gaps and bucket overflow cannot silently remain complete. The existing 1,000-bucket bound caps the exporter at 3,004 samples; source IPs remain in JSON evidence rather than metric labels. CPU/NIC metrics stay unknown.

The new dashboard distinguishes collector continuity from PASS/FAIL and source-read timestamps from query evaluation time. Legacy generator-failure descriptions are corrected in the API catalogue and both dashboard copies; old live-series labels still lack per-run identity and need a coordinated emitter/query migration before concurrent multisite interpretation. The independent probe remains campaign-selected; configuring its URL does not select it automatically. The production control plane's configured-provider flags do not prove these lab sources are connected to production.

Qualification still needs actual protection-entry measurements, functional journeys, explicit clock/calibration evidence, received-load validation under an authorized campaign and Kusa. Do not reuse synthetic-bench packet counters as HTTP ingress evidence. No campaign is launched by the exporter or monitoring checks.
