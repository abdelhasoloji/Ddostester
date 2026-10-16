# DRS campaign management and Run Theater

Source increment after build 486. Deployment identity is recorded separately in current setup.

## Campaign workflow

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
