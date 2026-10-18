# Observability and evidence provenance

## Individual Run Theater graphs — 18 October 2026

Source now provides four compact graph cards, an evidence-aware catalogue, individual expanded views, pause, custom time ranges, URL/series filters, CSV and campaign-scoped links. Interval rates use counter differences; probe checks are observed points, and latency remains explicitly cumulative. Missing instrumentation stays unavailable. Live and retained replay share the same renderer. No account, execution-limit or Pod configuration changes. Local journey and delivery status: [acceptance record](qa/run-graph-explorer-2026-10-18/README.md).

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

## DRS campaign dashboard

`shieldtest-drs` selects a campaign UUID and immutable revision UUID. The API's `/metrics` projects every stored revision using the same `assessDrs` function as the JSON/HTML report. It exports reference/profile/plan identity, current workflow phase, assessment availability, terminal status, optional score and per-level coverage. Missing evidence or a null score stays absent; failed integrity exposes availability zero without failing unrelated metrics. Excluded vectors are a subset of unknown coverage, not an extra denominator. Simulations remain explicitly labelled `engine-validation`; an experimental or simulation score is not a measured resilience claim. Finalization is a separate label from assessment completeness.

Run Theater provides a DRS link with both campaign and revision identity alongside the existing run dashboard. The native Grafana/Prometheus stack on the lab host scrapes the central API through its existing loopback SSH transport. The Kubernetes Grafana has the same dashboard definition, but its Prometheus scrapes the separate lab control; a campaign absent there must remain absent. Provisioning a model does not connect those two data sources.

This first view covers the authoritative assessment, not a complete physical exposure timeline. Requested/emitted/independently received load, functional journeys, recovery, historical attempt timelines and fresh agent counts still require correctly correlated series. The existing generator charts are diagnostics; they cannot substitute for independent protection-entry evidence. No new execution adapter, agent capacity or campaign is enabled by this delivery. Revision labels grow with retained campaign history, not agent count; capacity testing of the metrics scrape remains necessary before expanding assessment retention.

## Workflow archive and live reported Fleet participation

The source adds separate read-only `/metrics/drs-timeline` and `/metrics/fleet` endpoints. The first exports recorded workflow transition timestamps by campaign/revision/event index, including repeated phases. These are control-plane timestamps; they are not physical exposure or recovery durations. A global 2,000-event budget keeps that scrape below 2,500 samples, and omitted/invalid events are explicitly counted. The complete archive remains in the application report.

New Fleet missions capture the frozen DRS revision and mode at creation. Legacy unbound missions and simulation are omitted rather than retroactively associated with a measured run. The counter requires coherent membership, RUNNING parent and shard, valid parent/agent leases, and an agent progress observation no older than six seconds with no future timestamp. Stale or missing reports become unknown; partial membership never yields a plausible zero-agent campaign. Terminal reports with an unexpired agent lease remain uncertain. This is reported execution, not delivered traffic, physical source diversity or an assertion that a stopped worker emitted nothing.

The Fleet metrics SQL uses a read-only join of persisted missions/runs/shards, without calling coordinator snapshot or expiring/settling a mission on a scrape. It emits at most 32 missions, with no per-agent labels; a 200-sample scrape budget accommodates the bounded output. Settled missions remain in application history and are absent from the live counter. Database failure must fail the scrape, not return healthy zeros. The dashboard removes live samples once the exporter observation is over 20 seconds old and exposes collector health and export omissions. The actual sampling interval is five seconds.

Before rollout: run the full CI and PostgreSQL integration checks, back up configuration, deploy the exact verified API/UI release, and add the two jobs to the **existing native** Prometheus configuration with promtool validation and a rollback copy. The host bootstrap file is a fresh-install template, not a command to overwrite a running host. Preserve unrelated native jobs and dashboards. Publish dashboard version 2 only after endpoints are healthy, and verify actual phase timestamps, missing evidence, expired leases and revision binding. No campaign needs to be launched to validate archived phases; live participation requires an independently authorized bounded test or existing observations.

The Kubernetes control still needs a separately verified image containing the endpoints before it can supply these new series. Do not enable successful-looking substitute series in that lab. This candidate does not raise the current three-agent execution envelope or establish 5,000-agent capacity. Unit tests and disposable PostgreSQL integration cover freshness, bounded cardinality, revision binding, missing coordinator records and a server-enforced read-only transaction. Full CI, rendered Grafana behavior and live collection must be verified for each delivery.

### Single-owner confirmation and stored DRS plans

Execution confirmation and retained suite confirmation validate the authoring fields of the stored campaign without presenting its server-owned DRS document as new client input. The original stored document continues into the frozen-plan integrity/mode/budget checks and execution; confirmation does not replace it with a new revision. Client-provided evidence documents remain rejected on campaign creation. Regression coverage includes frozen-plan execution through a mocked runner, missing confirmation, draft/corrupt/simulation rejection, and legacy/frozen suite confirmation. A private-lab acceptance attempt exposed this validation error before any baseline or worker traffic; runtime acceptance must follow the verified deployment of the fix.

### Baseline refusal and asynchronous start

The baseline probe uses one-second start-to-start cadence without catch-up bursts, a bounded five-second request timeout and a 600-second observation ceiling. An unstable initial five-minute distribution is extended in small batches while preserving every observation; a batch is not scheduled if it cannot fit with one request-timeout reserve. Stability still uses the full distribution and the frozen coefficient-of-variation tolerance. Cancellation, unhealthy service, incomplete observation, deadline and instability remain refusals, never success.

Failed baseline diagnostics are archived on the revision and rendered in JSON/HTML reports. They do not add proofs or change the score. The application starts execution with a short HTTP 202 acknowledgement after durable RUNNING admission, then follows stored campaign status and the progress stream. A baseline-phase save now retains RUNNING instead of accidentally restoring APPROVED. The in-flight metric is decremented on failure as well as successful completion. Runtime acceptance of these changes requires a separately recorded delivery and private recipe; earlier failed attempts remain historical.
