# Synthetic Theater/report correction acceptance — build 476

Candidate `b862610d5d0dc1985187302b73eaf643d900d913` fixes all three reported defects. Twelve registered synthetic scenarios completed on lab VPS `31.31.74.187`, using the existing runner and its unchanged default limits. The first request was submitted in Run Theater; an acceptance driver dispatched remaining steps sequentially through the normal bench API and runner claim/result flow. Traffic stayed on loopback. No public reflector, Fleet mission, production user or production campaign was used.

## Results

- Run Theater updated from zero to **12 measured / 12 covered** without reload. Polling continues after terminal run writes, so a slightly delayed coverage write is also picked up. An intermediate candidate exposed this race and was superseded before promotion.
- All 12 individual report endpoints returned successful HTML with the matching run ID, status and outcome. All three TCP reports expose opened, accepted, refused, peak and capacity counters without unrelated UDP metrics.
- The aggregate report shows **12 laboratory observations, three state-table saturation outcomes and nine unmitigated baselines**. No zero HTTP WRS or global clean-target conclusion is fabricated when there are no HTTP runs.
- Regression tests also cover period filtering, retaining adverse history after a newer observation, missing counters and escaping stored text.

The nine UDP observations have no scrubber and do not prove mitigation. All three TCP scenarios saturated the bounded receiver state table. COMPLETED is an execution status, not a DRS PASS.

## Scope

The API/UI use the same candidate source and build identity. Lab assets were compiled on Mac; the native Linux release is built and verified independently. The fixture uses fresh MemoryStore and development team authentication, not production accounts or PostgreSQL. Production browser visual acceptance remains blocked by its saved origin policy. No alternate browser or production authentication workaround was used.

This covers **12/12 available network-bench scenarios**, not the whole official framework through DRS 5. Six out-of-model entries remain explicitly unexecuted. No physical DRS score or certification is established. The three persistent IoT Pods were not used or recreated. Temporary qualification application/tunnel were stopped after capture; the normal lab runner remains active.

## Evidence

`catalogue.json`, `runs.json`, `coverage.json`, `audit.json` and per-scenario JSON/HTML retain raw measurements and results. `theater-final.ax.txt` and `theater-final.png` prove the final live coverage; `tcp-report.*` and `aggregate-final.*` document visual report checks. `receipt.json` records scope and source. Deployment receipt is separate from qualification observations.

## Delivery

Build 476 was promoted at 12:52 UTC after four green exact-source CI jobs, complete native verification and authenticated database recovery. API/UI identity, HTTPS/mTLS and readiness passed. All account/campaign/settings/Fleet fingerprints and prior audit history were preserved. Three agents remain online. See [deployment receipt](deployment.json).
