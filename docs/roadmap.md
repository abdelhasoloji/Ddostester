# Current implementation and remaining work

## Ten focused code reviews — source, 18 October 2026

Six defects corrected across CSV export security, metric catalogue validation, memory transaction lock release, monitoring series identity, non-finite monitoring observations and optional PDF fallback. Shared CSV protection and snapshot field inventory reduce duplication. See the [ten-review record](qa/code-review-10-2026-10-18.md) for inspected paths, tests, unchanged policies and remaining limitations. This source work is not yet deployed; production remains build 496.

## Report evidence coverage follow-up — source, 18 October 2026

The consolidated report now distinguishes planned scenarios from retained run evidence in its cover and summary. Inconclusive scenarios are no longer universally described as rate shortfalls: missing evidence and execution failures remain distinct in their details. A retained run must match both the campaign's run ID and campaign ID before it contributes to the report. Production remains verified build 496 until this source increment passes delivery gates. No generators, traffic limits, accounts or Pods change.

## Current release and measurement consistency — 18 October 2026

Production delivery is verified as build **496**, commit `e1d6b126a2ebd1c91c093c346c9439fdaeabbe89`, promoted at 16:39:52 UTC. The [delivery receipt](qa/report-theater-consistency-2026-10-18/deployment.json) records matching API/UI identity, four green exact-source CI jobs, authenticated backup recovery, preserved history and three unchanged Ready Pods. Single-owner policy and the legacy campaign catalogue are unchanged. Older release statements below are historical observations, not the current release.

The deployed increment shares interval-rate, finalized-failure and probe-observation transformations between Theater and individual/suite reports. Missing counters/reset intervals break curves; monitored checks are dots rather than continuous uptime. Historical cumulative data remains explicitly labelled. The [five-pass review](qa/report-theater-consistency-2026-10-18/five-pass-review.md) distinguishes verified behavior from external prerequisites.

The twelve-step historical suite has eight retained runs and four missing engine reports. Re-rendering those observations does not replay the generators or establish DRS 5 coverage. Physical qualification still requires independent received-load evidence, functional journeys, recovery and calibrated capacity.

Rancher admission remains unavailable from this workstation at this checkpoint: `rancher.wedos.global` resolves to `10.20.0.252`, routed through `en0` via the home gateway; TCP/443 timed out and no local Kubernetes context exists. No ac02 deployment was attempted. Browser permission for the production application remains a separate unresolved constraint.

## Individual Run Theater graphs — 18 October 2026

Source now provides four compact graph cards, an evidence-aware catalogue, individual expanded views, pause, custom time ranges, URL/series filters, CSV and campaign-scoped links. Interval rates use counter differences; probe checks are observed points, and latency remains explicitly cumulative. Missing instrumentation stays unavailable. Live and retained replay share the same renderer. No account, execution-limit or Pod configuration changes. Local journey and delivery status: [acceptance record](qa/run-graph-explorer-2026-10-18/README.md).

## Full ZeroBS suite check — 17 October 2026

The isolated 12-step original-duration suite was attempted once: four completed runs, four automatic availability stops and four k6 output-budget failures. All approval/execution bounds remained in force. The consolidated report has four inconclusive rows, but incorrectly renders missing measurements as zero; engine failures also remain APPROVED/queued in campaign tracking. This is not a validated full suite. Target health recovered and three Pod identities/readiness are preserved. Production stays build 476; the UI simplification remains local source. See [evidence and defects](qa/zerobs-full-2026-10-17/README.md).

## Campaign interface simplification — source preview, 17 October 2026

Campaigns now opens the template catalogue as its sole creation surface. History and assessment evidence have separate tabs. Legacy launch/plan/guide URLs land on templates; Fleet configuration is a template continuation, and selected DRS profiles retain their configuration handoff. Synthetic dispatch is offered in the template catalogue; Theater and Settings retain results and link back to templates instead of creating campaigns. Template and composed-suite creation return to history. No backend authorization, approval, traffic limits, scenario definitions or production data change.

Navigation/theme controls use monochrome outline icons. Template summaries and generator explanations use keyboard-focusable help tips; required target/budget and confirmation information remains visible. Cards have restrained borders and no decorative shadows. The assistant starts collapsed when no saved preference exists. This increment is a local source/visual preview, **not deployed**; production remains build 476.

## Synthetic reporting correction — 17 October 2026

Source now refreshes bench coverage alongside polled run results, renders TCP opened/accepted/refused/peak/capacity counters in individual reports, and separates network evidence from HTTP WRS in aggregate conclusions. Empty HTTP periods no longer render a zero score; network saturation and unmitigated-baseline outcomes are counted without declaring targets clean. Bench evidence respects report period filters and adverse historical observations remain in the conclusion. No execution limits, accounts, generators or Pod definitions changed. Delivered build **476**, commit `b862610d5d0dc1985187302b73eaf643d900d913`, at 12:52 UTC. Full local/native gates and all four exact-source CI jobs passed, including PostgreSQL and recovery. The isolated lab replay completed 12/12 supported scenarios; live Theater coverage reached 12 without reload, all reports matched retained evidence, and the aggregate correctly showed three TCP saturation outcomes and nine unmitigated UDP baselines. Production API/UI identity, readiness, sole admin, 11 accounts, 289 campaigns, settings, audit and three online agents were preserved. No production campaign was launched. See [acceptance](qa/synthetic-reports-476-2026-10-17/README.md) and [deployment receipt](qa/synthetic-reports-476-2026-10-17/deployment.json). Six out-of-model scenarios remain unexecuted; no physical DRS qualification is claimed.

## Selected synthetic workflow — 17 October 2026

Delivered as build 473 / `0e43cea`, with four green CI jobs, native release checks, encrypted recovery, matching API/UI identity and preservation checks. The three agents are online and their Pod UIDs are unchanged; the bench runner is active. The real campaign qualification remains isolated lab evidence, not a production browser run. [Deployment receipt](synthetic-bench-deployment-checkpoint.json).

The operator replaced the GET-rate objective with a bounded synthetic bench campaign. The existing governed bench cockpit is available in Run Theater, with receiver packet/bit counters and dedicated per-run reports. A real isolated six-second DNS-shape scenario completed with 720 received packets, 3.213 Mbit/s and an observed 40× byte ratio; it is an unmitigated baseline, not a DRS pass. Preserve the earlier HTTP shortfalls as diagnostics. Delivery must verify exact API/UI identity, existing admin/history/three Pods and bench runner configuration. Production browser acceptance remains independently blocked by its saved origin permission; see [current setup](current-setup.md#synthetic-bench-replaces-http-qualification--17-october-2026).

## ZeroBS throughput delivery — 17 October 2026

Source fixes explicit main-target preservation for GET-Flood, custom-template round trips, cancelled Vegeta report parsing and consistent successful-response rate windows in Theater/reports. Existing concurrency ceilings and stored campaigns remain intact. The isolated private lab reached 794.04 RPS live but varied with shared-host/collection load, so sustained 800 RPS is not yet qualified. Separate the generator/probe/collection capacity and obtain a stable reserved execution envelope before claiming that rate. See the dated throughput observations in [current setup](current-setup.md#zerobs-throughput-correction--17-october-2026).

## ZeroBS / Vegeta follow-up — 17 October 2026

The isolated GET qualification retained a final report after correcting cancelled-run evidence parsing. Report source also fixes transport/HTTP counts and an unsupported collateral-cause claim. The measured rate was 178.43 RPS: 800 RPS remains unqualified. Next: promote reviewed corrections through normal release gates, restore production browser permission, then qualify the intended direct target path and a separately routed probe. Preserve concurrency bounds and the failed attempt. Evidence is linked in [current setup](current-setup.md#isolated-zerobs--vegeta-qualification--17-october-2026).

Reconciled against source and verified build 466 on 15 October 2026. This is the status authority; older plans and audits are not deployment claims.

| Workstream          | Delivered                                                                                                                         | Remaining                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Access              | Single-mode default, sole admin abdelha@wedos, server capabilities, managed profiles, audited recovery/session policy             | Complete operational account/rotation corpus as deployments evolve                                                  |
| DRS reference       | Official 3.00.00 PDF/license, 37 types, 131 rows, immutable hashes, 140 recorded anomalies/choices                                | Review unresolved verdict-affecting ambiguities; version any interpretation changes                                 |
| Scoring             | Separate validity/outcome, full denominator, terminal rules, equality interpretation, historical failures                         | Independently qualified real evidence for measured claims                                                           |
| Assessment workflow | Three modes, plan revisions/freeze, capacity state, software fixtures, evidence archive and JSON/HTML reports                     | Production collector bindings and complete physical orchestration qualification                                     |
| Fleet product       | Inventory/enrollment, multisite paging/selection, three persistent HTTP workers, shared budgets, Run Theater count, stop/receipts | Operator automation for provisioning, certificate/key renewal and expanded mission support                          |
| Scale               | Registry tested with 5,000 devices/100 sites in memory/PostgreSQL                                                                 | First qualified site of 50; then staged multi-site admission and observed capacity, no 5,000-worker execution claim |
| Kubernetes lab      | Mac kind manifests, Linux k3d/K3s lab, restricted workloads, dedicated target/probe, monitoring                                   | Full Mac/Linux parity and operations corpus; team-cluster CIDR/SNAT/egress agreement                                |
| Evidence/operations | Transactional persistence, source identity, archive integrity, backup/restore and witness tooling                                 | Retention/rotation/failure rehearsals and independently managed evidence acquisition                                |
| Synthetic bench     | Separate governed artifacts, actual measured counters, confined scenarios                                                         | Qualified calibration and DRS mapping; no accounting multiplier                                                     |
| Kusa                | Integration boundaries documented                                                                                                 | Obtain official endpoint/schema/auth contract, bind collectors and validate readiness/stop/failure behavior         |

## Next delivery sequence

1. Obtain independent protection-entry and origin metrics endpoints, functional-journey definitions, clock/source/calibration evidence and the Kusa contract.
2. Implement collectors behind the existing evidence ports; prove gaps/saturation/outages cannot PASS, and recalculation is reproducible from archived artifacts.
3. Admit a first infrastructure site of 50 only after network identity, quota, secret rotation, egress restrictions and stop behavior are reviewed and tested. Current execution ceilings remain unchanged until a separately qualified capacity envelope is implemented.
4. Expand site inventory and orchestration in controlled stages; test partitions, lost agents, lease expiry, duplicate delivery, restart and source observations before raising execution capacity.
5. Qualify measured assessments and operational dashboards/reports, preserving historical failures and incomplete coverage.

These are dependencies and planned increments, not scheduled autonomous campaigns. No feature completion or registry fixture establishes certification, Internet distribution or maximum throughput.

See [DRS contract](drs-engine.md), [setup](current-setup.md) and [handoff](infrastructure-handoff.md).

## Reliability increment — 15 October 2026

Source changes retain the existing coverage floors and include PostgreSQL contracts in backend coverage. Behavioral tests cover Fleet admission and revocation, exact multisite selection, DRS evidence/revision failures, conservative telemetry continuity and assistant confirmation/error handling. Form labels are associated with their controls. The heartbeat client avoids a near-deadline extra emission; target receipt resets/gaps cannot remain labelled complete.

This increment does not enable full-standard physical adapters, connect Kusa, provision a new site or raise Fleet execution limits. Production identity and remote CI results must be checked separately from local source/test results. The next external prerequisite remains the actual protection-entry/origin endpoint and Kusa contract.

Native deployment follow-up: the currently observed systemd API process runs as root. Prepare and qualify a migration to an unprivileged runtime account, including protected file/PKI access and rollback; do not confuse this with the Kubernetes Pod restrictions already present.

Deployment verification exposed duplicate engine discovery on installed-tool hosts. Suite preparation now reuses its discovery result and rejects invalid destinations first; this affects the retained legacy API, not the DRS-only catalogue policy. Production promotion remains conditional on the native gate and exact API/UI identity. The runner's release-directory permission mismatch remains an automation follow-up rather than a reason to grant unrestricted sudo.

The reliability increment and suite-preparation correction were delivered as commit `1e3a6f13429fedb7e219469fa25cbf72f90ddd8c` after green CI and native VPS gates. API/UI identity, preserved accounts/history/configuration and three online agents were verified. See [current setup](current-setup.md) for the checkpoint. Independent collectors/Kusa, the first infrastructure site, runner deployment permissions and the unprivileged native runtime remain open; no execution ceiling was increased.

## Monitoring increment — target receipts

The source monitoring overlay bridges the existing HTTP target receipt log into Prometheus and adds a dashboard with campaign/run/source identity and explicit collector gaps. Six standalone exporter tests cover actual log ingestion, absence, partial writes, inode replacement, log gaps and bounded cardinality; CI runs them as a required quality step. Scrape/alert configuration has a separate promtool recipe. This closes a lab instrumentation gap, not the independent protection-entry/Kusa or measured-DRS qualification gap. A rollout must preserve PVCs and archive the target's previous ephemeral receipts before replacing its telemetry image.

## DRS Grafana assessment projection

The source now includes a campaign/revision-scoped DRS dashboard, authoritative assessment metrics and a Run Theater deep link. Missing scores and integrity failures cannot become zero-valued success. Deployment identity must be checked separately. The full correlated exposure/recovery timeline and live Fleet count in Grafana remain subsequent work; this increment does not qualify physical DRS collection.

## DRS workflow archive and Fleet monitoring follow-up

Source adds archived transition timestamps and a separate read-only Fleet monitoring endpoint. New missions retain the frozen revision; old unbound missions are omitted explicitly. Fresh reported participation and unknown agents are distinct, and missing collector data is not zero-filled. Unit tests and disposable PostgreSQL checks cover this projection and its read-only behavior. Current setup still distinguishes the previously observed release from subsequent operator delivery receipts; no physical exposure/recovery qualification or Fleet capacity increase follows from these panels.

## Fleet acceptance finding — 15 October 2026

Build 463 fixes stored-plan confirmation and is verified deployed. The private three-agent / shared 3 RPS / 30-second acceptance attempt stopped at the baseline guard before any mission. Its final report remains indeterminate; live participation and natural stop are unqualified. See the [dated setup receipt](current-setup.md#private-fleet-acceptance--15-october-2026-11431154-utc).

Baseline diagnostics and nonblocking start acknowledgement are delivered in build 465. Revision 2 confirms 100% availability but CV 1.240138 against the frozen 0.1 tolerance; no mission was created. Next: qualify the probe/target measurement chain and a representative functional reference, including latency precision, timing noise and resource contention. The short existing-probe precheck is also dispersed and is not a qualified replacement. Preserve the tolerance, failed revisions and raw distributions. Only a successful bounded run can validate live participation, target receipts and natural stop. Agent-loss and emergency-stop rehearsals remain unperformed.

## Baseline and launch reliability follow-up

Source now retains explicit baseline refusal diagnostics, bounds extension batches before the absolute deadline and uses start-to-start probe cadence. The frontend uses nonblocking execution acknowledgement and follows persisted state; baseline persistence retains RUNNING. Tests cover cadence, convergence without dropped samples, deadline reserve, cancellation, confirmation, duplicate admission, kill availability and archived report diagnostics. Source/test success alone does not close private Fleet acceptance; deployment and the same bounded recipe must still be observed.

Build 466 is verified deployed after green CI/native gates and exact API/UI identity checks. It additionally spaces probes across extension batch boundaries; the build-465 observed sample count is retained with its cadence limitation. All 284 campaigns, account/settings digests and three agent identities are preserved. The private recipe's explicit instability diagnostic, rather than transport timeout or generic internal error, is delivered. Physical Fleet acceptance remains open: qualify the reference/measurement chain before repeating; do not reinterpret missing traffic or a null score as success. See the [delivery and recipe receipt](drs-baseline-checkpoint.json).

## Owner-directed classic workspace restoration — 17 October 2026

The active delivery request is to restore the `origin/main` application on `codex/main-classic-three-pods`, keeping the single administrator, explicit campaign confirmation and existing three-agent Kubernetes lab. The redesign roadmap is not being applied on this branch. Preserve the newer branch/releases and all database history. Release gates include current-database backward-compatibility verification, encrypted isolated recovery, exact-source CI/native validation and post-promotion data/account/Fleet checks; no campaign generation is necessary for this restoration.

The owner-directed restoration is deployed as build 468 on `codex/main-classic-three-pods`. Exact-source CI/native gates, current-database backward compatibility, encrypted recovery and preservation checks passed; the original three Pods and single administrator are retained. See [delivery receipt](classic-main-deployment-checkpoint.json). Newer workspace work remains on `codex/passive-pop-readiness`; no redesign is merged into this classic branch.

### Correct restoration target: historical ZeroBS templates

Restore the existing `legacy` catalogue profile rather than only the classic main navigation. The code already contains all 43 historical curated definitions; identity and steps match `d98db08`. Preserve the currently verified application, account policy and three Pods. Only the catalogue selection changes; do not reimplement attack mechanisms, increase limits or present the separate Fleet GET alternative as the original multi-step sequence.

Historical catalogue activation is verified delivered on the unchanged build 468: `legacy` template workflow, persisted sole administrator and original three Pods, with fresh recovery and preservation checks. The published branch is `codex/zerobs-classic-three-pods`. See [activation receipt](zerobs-catalogue-deployment-checkpoint.json). No production campaign or new generator mechanism was introduced by this delivery.

### ZeroBS execution corrections — 17 October 2026 (local source)

The full original-duration qualification exposed four k6 output-budget failures,
four automatic safety stops and misleading missing-evidence presentation. Local
corrections suppress k6 progress/request logs without increasing process or traffic
caps, reject absent request metrics/nonzero engine exits, retain diagnostic references
in audit and suite reports, show failed steps explicitly, keep an observed suite
on stage after completion, and report missing load/availability as unmeasured.
Delivery ratios now compare mean achieved and mean expected rates, with peak
configuration identified separately. Approval messages reflect actual approved/skipped
counts. Existing local interface changes and historical qualification evidence are preserved.

These source changes are not a deployed release or a new successful 12-step
qualification. The HTTP-only lab target still cannot establish HTTP/2 coverage;
automatic safety stops remain active, and 800 req/s capacity is not established.
k6 flags follow the [official options reference](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/).

### Short ZeroBS replay — 17 October 2026

An isolated authenticated lab replay executed all 12 legacy L7 scenarios with
20-second configured load windows and no added interval. Existing baseline,
calibration, recovery and stop controls remained active. All 12 run records and
the consolidated report were retained; the sequence took 343.177 seconds including
those controls. Four k6 runs completed without the previous output-budget error.
The target recovered to HTTP 200 and the three persistent IoT Pods were preserved.
No production release was promoted. Phase rounding was corrected so wave/ramp
phases sum to the requested duration (20 seconds, rather than 21); 1,239 backend
tests, lint, type checking and compilation passed.

Graph review still found HTTP panels on the slow-connection scenario, an outage
banner not always supported by probe availability, zero-filled historical k6
load curves despite nonzero final summaries, missing persisted probe p95 samples,
and a breach glossary that incorrectly assumes an automatic kill. Four probe
samples per 20-second window are coarse; HTTP/2 coverage is not established on
this HTTP-only target. These findings are recorded, not claimed fixed by this replay.
See the [replay receipt](qa/zerobs-20s-2026-10-17/receipt.json) and
[retained report](qa/zerobs-20s-2026-10-17/report.html).

### Graph and report consistency audit — 17 October 2026 (candidate source)

The corrective source now retains explicit generator observation, successful counters,
probe sample counts, probe p95 and request/connection units in each timeline tick.
Live and historical app graphs share that contract. Unknown counters stay absent;
SlowLoris uses connection counts, and generator errors do not declare a global outage
or mitigation. Rates are cumulative means, not instantaneous peaks. Probe plots hold
observed values rather than smooth invented intermediate measurements, with observation
counts and cumulative semantics disclosed. Probe cadence and traffic caps are unchanged.

Both report types share evidence charts: historical k6 summaries cannot manufacture
a load timeline, missing latency remains unrecorded, and old records are not rewritten.
Derived assessments are refreshed at read time so cached historical interpretations do
not contradict current reports. HTTP/2-named runs without confirmed target support are
inconclusive. WRS remains a legacy diagnostic, distinct from a measured DRS score;
completion and safety-stop status are separate from the resilience verdict.

Grafana's live failure stat no longer falls back to an earlier run. Instant live stats,
non-smoothed sample steps, explicit absent values and neutral outcome labels preserve
the same meaning as the app. The source dashboard and Kubernetes copy remain aligned.
Deployed as build 483 (`d15afa3d8a09670e492634529029db7274e3d1cc`) after exact-source CI, native build/report checks and authenticated recovery. API/UI release identity, readiness, runtime configuration, all 289 campaigns, 11 accounts, the sole administrator and three Fleet identities were preserved. The private-lab replay completed all 12 steps at 20 seconds each with no added interval; final reports were regenerated from unchanged measurements. Both native and Kubernetes Grafana dashboards are loaded and the three persistent IoT Pods remain ready. Evidence: `docs/qa/graph-consistency-2026-10-17/`. Production browser access remained denied by its saved policy; the UI was verified in the isolated lab and production through authenticated health, asset and database checks.

### Three-pass critical report review — 17 October 2026 (source)

Three successive reviews cover numeric/graph accuracy, evidence-strength conclusions,
and coverage/traceability. Corrections include the real 0–100 WRS component scale,
unknown probe/risk values, current assessments in aggregates, descriptive comparisons,
complete-suite SLO requirements, connection CSV units, imported-lab uncertainty and
separate collection/render identities. Raw archived measurements and execution caps
are unchanged. See `docs/qa/reports-critical-2026-10-17/` for the three-pass record
and regenerated reports. This source review is separate from the deployed build 483;
any later release activation is recorded with its own delivery receipt.

Candidate build 485 (`0b5f403e396133f8e7763f9d7eae00fad8128d1c`) passed local checks and regenerated 227 historical individual reports and 50 suites on an isolated restored database. Production build 483 is retained while a new suite is running. Refresh the preservation snapshot and authenticated backup after that execution completes before any activation. No campaign was launched for this review.

Report corrections activated as build 485 (`0b5f403e396133f8e7763f9d7eae00fad8128d1c`) on 17 October 2026 at 20:54 UTC, after campaign completion and fresh authenticated backup recovery. All 301 campaigns, 11 accounts, sole administrator, settings, caps and three Fleet identities were preserved; HTTPS/API/UI identity and three ready IoT Pods were verified. Receipt: `docs/qa/reports-critical-2026-10-17/delivery.json`. This supersedes the earlier deferred activation status.

### Scenario fidelity and monitored-route availability — source correction

The classic negative-path step now preserves its specified paths instead of recon replacing them with a dynamic endpoint. Its expected missing resources are excluded from functional monitoring. Positive endpoint mixes include the selected probe and the resolved route URLs, bounded to eight monitored URLs in `config/limits.ts`. Every URL is allowlisted and revalidated before execution. Each URL is checked with a read-only GET; one aggregate probe cycle succeeds only when all checks succeed, using the existing timeout/cadence and automatic-stop thresholds. Individual counts appear in live tooltips, run details and reports. Per-route baselines are retained; primary-only baseline latency is not compared with a multi-route maximum.

Requested load remains the assessment denominator after downward calibration. A reduced exposure cannot pass the original requirement. Rapid Reset/Continuation are explicitly HTTP approximations; the classic THOR wave and carpet-bombing labels disclose one generator/one host. These approximations cannot establish the named protocol/distributed resilience. Historical evidence remains unchanged, while current projections flag missing route coverage and unsupported conclusions.

This corrects measurement and interpretation; it does not raise traffic limits, add amplification, improve flood throughput, implement protocol abuse or establish DRS 5. GET route checks do not verify authenticated or POST transactions. A broader journey requires explicit assertions and independently received-load evidence. Local regression coverage includes a healthy root with a failed application route, automatic stop, per-route baselines, live progress and final report. No external campaign is needed for this verification. Activation must have its own delivery receipt.

Scenario-fidelity candidate build 488 (`7a0ed66ee0820c05a5b703ed6c7c588a5bfdb09b`) passed 1,270 backend and 471 frontend tests, 287 native Linux checks and exact-source CI 39069978751. The restored-copy check regenerated 239 individual reports, 51 suites and the portfolio without mutation. Activation was refused before restart at 21:19 UTC because the campaign count rose to 305 with one running campaign and changed account records. Production remains build 485. Refresh the backup/preservation snapshot after that execution before activation; do not reuse the earlier 301-campaign snapshot. Evidence: `docs/qa/scenario-fidelity-2026-10-17/validation.json`.

### Protected zones workspace — source implementation

The default screen now shows authorized hosts from the current target registry and configured allowlist; the filter exposes all registered records for management. It supports authorization filtering, host/name search, live campaign links, template-based configuration and capability-governed target metadata/authorization management in collapsed details. Configured access is identified separately because revoking a registry entry does not remove an independent environment allowlist entry. No health check or traffic is started by this screen, and authorization is not presented as service availability.

Retained campaign-derived hosts are loaded only when Historical activity is opened. That section has search, pagination, recorded dates and an exact-host link to the campaign history including archives. Historical WRS, inferred edge absorption and name-derived DRS levels no longer appear as current assurance. Campaign history now honors the explicit `host` and `archived=1` deep links; the host filter is visible and clearable. Existing authorization rules and raw history are preserved. Isolated frontend workflow tests and local visual fixtures cover these changes; this is not a production activation receipt.

### Interface visual acceptance — 18 October 2026

Implemented locally: compact common spacing, mobile navigation, wrapping template rows, dialog keyboard/scroll handling, viewport-positioned help, aligned actions and Theater charts. Eleven routed views and principal dialog/help/authentication layouts were checked with isolated desktop/mobile fixtures; 480 frontend tests pass. Production-data/provider and every role/error combination remain outside this visual review. Source changes await delivery; see [review evidence](qa/interface-consistency-2026-10-18/README.md).
