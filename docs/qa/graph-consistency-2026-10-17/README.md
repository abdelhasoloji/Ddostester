# Graph consistency audit — 17 October 2026

Delivery source: `d15afa3d8a09670e492634529029db7274e3d1cc` (build 483).

The audit covers campaign launch, generator/probe evidence, live and retained Theater panels, CSV, individual and consolidated reports, and the campaign Grafana dashboard. The issue register is `../../graph-consistency-audit.json`.

## Verified behavior

- Unknown telemetry remains unknown, including external-engine live rates. Final totals never manufacture a historical curve.
- Connection holds use connection counts and have no HTTP latency, HTTP failure funnel or request-rate outcome widget.
- Request-rate panels use the generator clock, measured successful counters and explicit mean semantics. Probe graphs retain sample counts and cumulative p95; steps hold observed values without smoothing gaps.
- Generator failures, HTTP failures, probe failures and measured DRS evidence remain distinct. Report caveats remain visible even for breached diagnostic outcomes.
- Live Grafana stat queries are instant, without a fallback to the previous settled run. Other dashboards and the three persistent IoT Pod identities were preserved.

## Replay

The private Kubernetes lab ran all 12 ZeroBS suite steps with 20 seconds of configured load each and no added interval. Total configured load: 240 seconds; observed sequence completion: approximately 345 seconds including baselines, calibration and recovery checks. All 12 execution records and the final report were retained. Diagnostic outcomes: 3 held, 2 partial, 2 probe-failure breaches and 5 inconclusive. Completion is not a resilience pass.

Collection used commit `266e9a6`; the final build rendered those unchanged archived measurements. `replay-checks.json` proves equal collection/generator source hashes, counter conservation, monotonic timestamps, provenance and probe counts. The final source changes after collection concern interpretation/presentation and regression checks. No additional campaign was needed to regenerate the final reports.

## Delivery evidence and limits

`delivery.json` records actual production promotion and readiness; `history-recovery.json` records authenticated backup recovery and classic-mode compatibility with preserved accounts, campaigns and Fleet identities. `grafana-and-fleet.json` records dashboard query semantics and unchanged ready Pods. Screenshots and offline HTML reports are retained alongside raw campaign/run evidence (gzip files decompress to the original JSON bytes and hashes).

Production browser access was denied by its saved policy. Production verification therefore uses authenticated health, API/UI asset identity, database preservation and restored-copy compatibility; browser checks used the isolated lab application. Grafana definitions were verified in both native and Kubernetes installations. The isolated fixture was not scraped by Prometheus, so its graphs are not claimed as a Grafana capture.

This replay is not a measured DRS 5 result, HTTP/2 qualification, source-diversity proof or an 800 req/s capacity result. The lab endpoint used HTTP and only four completed probe transactions per 20-second step; those observations do not establish continuous availability or outage duration.
