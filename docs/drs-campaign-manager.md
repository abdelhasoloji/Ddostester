# DRS campaign management and Run Theater

Deployed as build 494 on 17 October 2026. Exact source, preservation checks and delivery evidence are recorded in [current setup](current-setup.md) and the [deployment receipt](drs-60-deployment-checkpoint.json).

## Per-reference synthetic journey v2 (build 494)

New campaigns retain every reference row through the chosen level, with a ceiling of level 5 / 60 steps. They no longer deduplicate shared presets: level 5 contains 15 separately measured partial-shape steps and 45 explicit no-traffic lifecycle simulations. These are 60 software scenario results, not 60 fully reproduced attack protocols or 60 qualified DRS verdicts.

Each frozen entry retains its exact source vector, load/service requirements, ambiguity identifiers and hash. The 15 measured entries reuse only existing registered isolated runner presets with unchanged per-run bounds. Their actual received counters and unique run identifiers are retained separately for each reference row. Parameters copied from the standard are reference requirements; they are not silently sent as generator settings. The 45 simulated entries use `reference-lifecycle/1`: reference load, simulated baseline/exposure/recovery events and completion. This model sends no traffic and models no actual target behavior, availability, latency or mitigation. It cannot demonstrate resilience. Its received load remains null, not zero, and it creates no bench verdict, coverage measurement or DRS proof.

The immutable chain and explicit approval cover the execution mode of every row. All 60 result slots are retained in the theater and final JSON/HTML, including NOT_EVALUATED on stop/error. The theater filters measured/simulated steps, shows counters by provenance and retains names, levels and source IDs. The HTML report has a compact per-scenario table and a collapsed frozen-reference archive. Finalization, quiet intervals, pause/stop, timeouts, restart behavior and audit remain governed. Existing v1 campaigns keep their original frozen plans and historical observations; creating a new campaign uses v2.

[Local qualification](qa/drs-60-scenarios-2026-10-17/receipt.json) completed all 60 results (15 measured partial shapes, 45 lifecycle simulations), including reload, result filters and opening the final report. [Final-source readback](qa/drs-60-scenarios-2026-10-17/readback-build494.json) generated no additional traffic. Exact-source CI, native verification and deployment identity/preservation checks passed.

The separate Fleet workflow and the level-6/7 reference catalogue are unchanged. No new network emitter, arbitrary destination, spoofing or public reflector is introduced.

## Legacy five-shape journey (build 492, 17 October)

The default manager now offers the isolated synthetic bench alongside HTTP Fleet. Select an objective and quiet interval, keep the configured isolated target, authorize the laboratory plan, create the draft, then review and explicitly launch its exact hash. Creation sends no traffic. Team mode retains separate approval; single mode retains owner confirmation.

The server persists the reviewed catalogue/shape snapshot and queues one existing named scenario at a time. The external runner only claims and returns its existing bounded observation. Successful settlement archives the diagnostic once and starts the interval. Pause holds admission. Stop cancels an unclaimed request and waits for a claimed bounded scenario; errors and queue/result timeouts halt admission and still finalize a report. Restart stops admission without replay. Atomic admission prevents overlap with standalone bench requests or another synthetic chain.

Run Theater opens with `?synthetic=<campaignId>`, follows persisted states, survives reload and displays received counters only when supplied. Finalization updates campaign status, stops polling and exposes protected HTML/JSON reports automatically. Objective 5 executes five unique existing shapes associated with 15 of 60 reference rows. Missing vectors remain unevaluated; no measured DRS 5 score is inferred. [Local end-to-end receipt](qa/synthetic-journey-fixed-2026-10-17/receipt.json).

API: `POST /api/synthetic-campaigns` creates a draft (name, targetLevel, intervalSec, labTarget, authorized). `GET /api/synthetic-campaigns/:id` reads state and ordered observations without dispatch. `POST /:id/start` requires confirmed and planHash; pause/resume/stop share the same prefix. State changes and result acceptance are transactional and audited; duplicate results are rejected. Generic execution and DRS mutation routes cannot bypass the coordinator.

## HTTP Fleet campaign workflow

Campaigns is now a primary navigation entry. Choose a target DRS score (integer levels 1–7), an interval in seconds, then configure the authorized target, observation URL, enrolled agents and shared budget. The complete reference chain contains every catalogue row through the selected level, in reference order. Unsupported rows remain visible as requiring a generator. Current execution remains the existing bounded GET approximation per level; source diversity, standard volumetric requirements and full combined exposures are not established.

Creation atomically records the supported scenario drafts under one suite identity, with an immutable reference catalogue hash, chain hash, target level and interval. No traffic is sent. Freeze the scenario plans, inspect the chain and explicitly confirm the executable laboratory sequence. Target score is an objective. Missing scenarios remain unevaluated, and sibling scenario scores are never averaged into a DRS score.

The minimum interval is 0–3,600 seconds, defined in `backend/src/config/limits.ts`. It starts only after a scenario settles. Existing recovery admission follows the interval, and every scenario retains its own baseline, frozen budgets, worker admission and stop controls. Pause holds the next admission; cancel interrupts the interval and stops the sequence. A failed admission/baseline or non-completed scenario halts this DRS chain. State and authorization are rechecked before dispatch; a cancelled or archived queued member is not launched from an old snapshot. Restart does not resume an unattended sequence.

The interval is immutable for a saved campaign. Duplicate into a new campaign to change it or the objective, retaining old attempts and reports. Campaign management includes saved chains, plan freeze, explicit confirmation, pause, resume, stop, archive and the consolidated JSON/HTML report. Stop remains available while a different control request is pending. Existing per-scenario evidence workspaces remain available.

## Observability

Run Theater adds native DRS score, coverage and Fleet participation panels using the same reviewed Prometheus expressions as the provisioned Grafana DRS dashboard. Every query requires exact campaign and revision identifiers. The server binds the time range to the selected revision, ending at finalization for historical reports, within the existing 24-hour query bound. Unknown, failed and absent observations remain unknown. Fleet participation retains Grafana's exporter-freshness condition; it is not proof of received traffic. Mode and finalization are visible. Finalized panels stop polling. The existing load/availability views and independent stop control remain in place.

Campaign transitions and live indicators animate; reduced-motion preferences disable animations. A scenario-interval countdown uses the server deadline. Suite scenarios now pass Fleet context to the real-time agent counter. Opening a governed chain does not trigger reconnaissance or dispatch traffic.

Full Grafana links retain exact campaign/revision scope and the recorded time window. Native panels avoid changing authentication or embedding policy. Grafana documents its [sharing options](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/) and [embedding configuration](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#allow_embedding); this increment neither enables anonymous access nor changes frame/security headers.

## API

- `GET /api/drs/sequences/plan?targetLevel=5&intervalSec=30`: immutable reference chain, supported/missing counts and plan hash; `campaign:read`.
- `GET /api/suites/:id/drs/plan`: saved reference chain verified against its hash, independent of future capability changes.
- `POST /api/drs/sequences`: authorized target/probe, name, targetLevel, intervalSec, Fleet IDs and existing bounded shared budgets; `campaign:create`. Scenario metadata is generated server-side.
- `POST /api/suites/:id/drs/freeze` with `planHash`: atomically freeze reviewed inactive plans; `campaign:approve`.
- `POST /api/suites/:id/run`: existing execution contract, plus the reviewed `planHash` for DRS chains. All current plans must be frozen and coherent; normal approval/explicit confirmation still applies.
- `GET /api/suites/sequences`: existing state plus `intervalEndsAt` while waiting. Pause/resume/cancel use the existing governed routes.
- `GET /api/suites/:id/drs/report[?format=html]`: target objective, interval, coverage, per-scenario state/evidence and full missing-reference rows; `campaign:read`. Reports remain partial without a qualified whole-standard assessment.
- `/api/metrics/range` accepts named `drs_score`, `drs_coverage`, `drs_agents` series with required `campaignId` and `revisionId`; raw PromQL and unscoped identifiers are rejected.

This is a campaign-management increment, not a new network generator, a DRS 5 qualification, Kusa integration, worker expansion or PoP deployment.

The reference catalogue is shown in full by default. Unavailable generators remain visible and cannot be launched; the optional filter only hides them for browsing. A reference row is not evidence of execution capability.

## Bounded synthetic catalogue — 17 October 2026

The reference catalogue defaults to **Bounded synthetic bench**, retaining all 131 source rows and a separate HTTP Fleet selector. Selecting a source does not change the standard or mark an unsupported vector executable. Registered bench shape associations are exposed as `laboratory` metadata, with represented/missing dimensions and `scoreEligible: false`.

Only explicit type associations are used: SYN → bounded connection pressure (not SYN packets), UDP → packet-rate shape, NTP → synthetic response shape, UDP multi-vector → synthetic mixed profiles, and pulsewave types → bounded UDP bursts (not application transactions). A generic UDP amplification reference may use the registered synthetic mix. Other rows remain reference-only; no regex or generic fallback invents support. The bench registry independently validates names and reproducibility.

**Prepare synthetic scenario** opens the existing governed bench form with the exact registered scenario preselected. It does not request a run, copy the client URL, or bind a synthetic observation as a DRS PASS. A missing preselected scenario fails closed without substituting another one. Only a separate explicit request can queue a run, subject to existing bench permissions, isolated `LAB_TARGETS`, runner configuration and fixed budgets. Runtime readiness is established by the bench form, not by catalogue metadata. No new generator, reflector protocol, source spoofing or higher budget is introduced.

Bench result/history and the existing diagnostic attachment contract remain available. Automatic DRS chain execution still uses its separately supported Fleet subset; this increment does not substitute the synthetic bench into that chain or claim measured level 5. Actual received counters retain their units and are never multiplied for scoring. Source implementation is not a deployed release.
