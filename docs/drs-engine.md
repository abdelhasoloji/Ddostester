# Versioned DRS engine

Current implementation, 14 October 2026. See [current setup](current-setup.md) for deployment observations.

Reference data live in `standards/drs/3.00.00/`. The original PDF, author and GFDL-1.3 license remain archived; catalogue JSON files preserve source identifiers as strings, sections/pages, per-line source text, requirements and conflicts. Do not alter this directory after release; a source or interpretation change requires a new version/profile. The startup integrity check validates every archived file. The importer `scripts/drs/import-catalogue.py` is deterministic and requires Python pdfplumber plus the repository Prettier tool; it is an offline reference-import operation, not an execution command.

Three modes are explicit: `engine-validation` produces simulation-only results; `synthetic-lab` produces experimental results limited to reproduced dimensions; `measured` evaluates imported independent evidence and cannot dispatch until physical instrumentation and capacity are qualified. No mode is certification. A 200 HTTP response cannot alone establish a working login, API journey or usable challenge.

The plan snapshots the standard version, catalogue hash, scoring-engine version and interpretation profile. It declares services, URLs/protocols/journeys, functional assertions and success tolerances, architecture and injection location, four measurement roles, sampling and clock uncertainty, baseline/exposure/recovery windows, shared execution budgets, stop conditions and protection/component versions. Probes must declare separate resources and connection pools from generators. Source exclusions retain the full denominator and are reported as partial coverage. Any modification creates a new revision; old revisions, reports and failed attempts remain readable.

The state machine is `DRAFT → PLAN_FROZEN → CAPACITY_CHECK → BASELINE → LEVEL_EXECUTION → RECOVERY → EVIDENCE_VALIDATION → LEVEL_CALCULATION → next level or FINAL_REPORT`. Event simulation uses a virtual clock, not five minutes of real waiting. Physical observation uses bounded deadlines and always stops injection before recovery. An unconfirmed stop or incomplete instrumentation cannot authorize a next level. The evidence API archives independently collected observations; it does not send traffic.

Execution wiring is deliberately split, and the names can mislead. `modules/drs/orchestrator.ts` implements the full sequence above and is exercised by `test/drs-orchestrator.test.ts`, but no production module imports it yet: the running control plane advances revisions through the transitions in `modules/drs/workflow.ts` (`app.runCampaign`, `routes/drs-routes.ts`). The HTTP generator is `engine/loadTest.ts` plus the `agents/` adapters — the DRS modules never import it; they reach it only through ports and bound it against `FLEET_LIMITS`. `orchestrator.ts` opens no socket and rejects any plan above that envelope.

Each attempt archives timestamps, requested load, independently sourced generator/entry/user/origin observations and artifact hashes, functional baseline and under-load transaction counts, full bounded latency samples with recomputed mean/percentiles, outage and recovery, manual interventions, gaps, injection location, physical/virtual counts, observed addresses, emulated/missing dimensions, calibration and joint-exposure identity. Unit-bearing load counters are used as recorded. A synthetic multiplier is never part of scoring. Evidence imported by a CISO remains labelled `collector-import`: structural validation and archive hashing do not claim physical attestation by the server.

Validity (`VALID`, `INVALID`, `INCONCLUSIVE`) is separate from outcome (`PASS`, `FAIL`, `NOT_EVALUATED`). Missing/unstable baseline, saturation, telemetry gaps, unknown received load, missing functional assertions, unsupported units, absent recovery and unresolved verdict-affecting source ambiguities cannot become PASS. A broken functional assertion with measured transactions is FAIL. Source diversity/persistence are conservatively required for complete positive coverage; these are profile interpretations and are not substituted with virtual clients or a short synthetic run.

Scoring retains the complete level denominator. It compares integer cross-products, without prior rounding: ratios strictly greater than 75% at levels 1–3 or 85% at levels 4–7 PASS; strictly below 40% FAIL; equal boundaries are MET under the documented conservative interpretation. A terminal MET retains its level score; FAIL uses the last passed level, or null if none exists. The plan's maximum level terminates the process. Unknown scenarios or unsupported exclusions make coverage partial; no full score is invented. Additional attempts beyond the terminal level are diagnostic. A valid failure in an earlier attempt is retained even if a retry passes. New configurations require a new revision rather than overwriting failures.

Authenticated API:

- `POST /api/drs/validations`: standalone offline validation, create capability; fictional scope, no target attestation or Fleet enrollment. Physical dispatch remains impossible. Finalization marks the software campaign completed without granting physical approval.
- `GET /api/drs/reference`: immutable catalogue, levels, types, scoring and ambiguities.
- `GET /api/campaigns/:id/drs`: revisions and default plan.
- `POST /api/campaigns/:id/drs/revisions`: new draft revision (`plan`), create capability.
- `POST .../freeze`: freeze current plan, approval capability.
- `POST .../capacity`: record current capacity qualification status, create capability.
- `POST .../simulate`: explicitly confirmed engine validation fixture, execute capability; no physical ports.
- `POST .../evidence`: append independent collector evidence, approval capability.
- `POST .../attachments`: archive existing `runId` or completed isolated `benchRunId`, approval capability; diagnostic only, same campaign target required for run attachments.
- `POST .../finalize`: always finalize an integrity-checked report, approval capability.
- `GET .../report.json?revision=N` and `.../report.html?revision=N`: reproducible archived results, read capability; HTML escapes evidence and has a restrictive CSP.

Mutations except revision creation require `revisionId` to reject stale clients. Archived campaigns are read-only; physical running campaigns refuse concurrent evidence mutations. Writes and audit receipts are transactional in memory and PostgreSQL. Evidence envelopes are centralized in config/limits.ts (32 revisions, 512 attempts/revision, 2,048 distribution samples, 1 MiB request envelope and 8 MiB campaign archive). These are storage limits, not generator budgets.

Independent entry/origin endpoints and real functional/calibration collectors need to be bound to the declared instrumentation before an evaluation can establish those dimensions. The default capacity response explicitly says physical execution is not qualified; the lab profile does not silently substitute other generators or create public reflectors.

## Reference and reproducibility

The pinned DRS 3.00.00 reference was published on 4 August 2026. It contains 37 type definitions and 131 vector rows, distributed by level as 2, 3, 7, 16, 32, 34 and 37. There are 140 recorded anomalies or interpretation choices, not 140 resolved defects.

- [Official source PDF](https://www.ddosresiliencyscore.org/wp-content/uploads/2026/08/DDoS-Resiliency-Score-Standard-3.0.pdf).
- [Archived source and GFDL license](../standards/drs/3.00.00/).
- PDF SHA-256: `7ce363c2f701185e7558634f9cc6bcf56d7a1c4992a4b08f71cc6f9e741ada4b`.
- Catalogue SHA-256: `43baa265b9f6675843473b1bf80666887eaf57377b1aa8c35b8891f4ef5ef856`.
- Engine: `shieldtester-drs/1`; interpretation profile: `strict-conservative/1`.

The source's inconsistencies are retained in `ambiguities.json`; an unresolved ambiguity affecting a verdict remains visible in the report. The application does not certify compliance or Red Button certification. Catalogue generation is an offline import, not a campaign or deployment.

A completed campaign always has a final report, but may have a null score or partial/inconclusive coverage. Failed tests remain in history when rerun. An untested service is never a successful service. WRS diagnostics must not be averaged or converted into DRS.
