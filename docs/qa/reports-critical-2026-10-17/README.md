# Three-pass critical report review — 17 October 2026

This review covers individual HTTP reports, suite reports, portfolio/compliance exports, run and suite comparisons, network-bench and planning reports, charts and CSV. Raw campaign history and measurements remain unchanged. No campaign or traffic generation was needed.

## Pass 1 — numbers and measurement semantics

Corrected absent probe observations appearing as 100% availability or zero latency in comparisons; premature rounding of small availability deltas; graphs bridging missing observations; clipped unit labels; fractional score gauges; and WRS component bars incorrectly scaled to 1 instead of 100. Single observed points remain points, not inferred trends.

## Pass 2 — conclusions and evidence strength

Aligned risk and verdict interpretation across individual, suite and portfolio reports. Unknown or inconclusive evidence has an explicit Unknown risk. Generator errors, response fingerprints and matching numeric fractions no longer establish an edge/origin mechanism or successful mitigation. Remediations require observed probe/timing evidence and do not invent DRS rules. Lab metadata with neutral outcomes is unknown; an unmitigated baseline cannot match the positive substring “mitigated”. Imported lab metadata and generator failures no longer establish presence or absence of target controls.

## Pass 3 — coverage, traceability and readability

A suite-wide SLO pass requires every member to be completed and evaluated; any historical failure still propagates. Summary-only suite comparisons remain descriptive. Run comparisons reject inconsistent target context and use the current evidence assessment. Collection source, runtime, run ID and generator window are separate from renderer identity. Connection-only CSV rows have dedicated counts and blank HTTP-only fields. Long metadata wraps and printed tables may span pages while rows stay intact. Suite provenance is compact.

## Validation

The retained 12-step lab dataset was regenerated into 12 individual reports, a suite report, a portfolio report, two comparison reports and a planning report. Input equality checks verify no archived evidence was mutated. Dedicated regression cases cover missing/invalid probes, fractional differences, internal data gaps, real WRS scale, incomplete suites, target mismatches, neutral/negative bench outcomes and request/connection CSV units. Browser review checks the report layout and visible uncertainty labels.

The archived dataset remains a bounded laboratory observation. It does not establish HTTP/2 support, a measured DRS 5 score, public-source diversity or an 800 req/s capacity result. Source implementation, rendered QA and actual deployment receipts are recorded separately.

Reproduce after building: `node scripts/qa/render-reports.mjs /tmp/reports-critical-preview`. The tool reads the retained dataset and renders files only; it does not start a campaign.

## Delivery status

Build 485 (`0b5f403e396133f8e7763f9d7eae00fad8128d1c`) was activated on 17 October at 20:54 UTC after the active suite finished. A fresh encrypted backup was restored and verified. API/UI identity, readiness, all 301 campaigns, 11 accounts, sole administrator, three Fleet identities and runtime configuration were preserved. HTTPS/mTLS health and all three ready IoT Pods were verified. See `delivery.json` and `delivery-status.json`. No campaign was launched for this deployment.

The restored-copy compatibility check regenerated 227 retained individual reports, 50 suite reports and the portfolio report without errors or database mutation. This check predates the active 12-step suite; it does not claim to have reviewed that unfinished execution.

Validation totals: 1,263 backend and 470 frontend tests passed locally, with 133 targeted tests passing on the native Linux candidate. Exact-source CI run: https://github.com/abdelhasoloji/Ddostester/actions/runs/39060734972 (status tracked separately in `delivery-status.json`).
