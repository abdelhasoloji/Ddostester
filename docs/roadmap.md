# Current implementation and remaining work

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

## Proposed RL300 infrastructure — study only

The declared estate is 20 ARM64 Ampere Altra Max RL300 servers (128 cores/1 TB RAM each), VPN management and separate direct test egress, with DRS 3.0 level 5 as an objective. The first infrastructure qualification stage is two servers under unchanged authorization/budget/stop policies. Native HPE execution, NIC/public-address mapping, complete physical DRS coverage and production sizing remain unqualified. No 16-server count is approved. See the [study](rl300-arm64-infrastructure-study.md) and [reproducible evidence anchors](rl300-arm64-evidence.json).

## Controlled product adaptation lots

The [RL300 product roadmap](rl300-product-roadmap.md) defines the complete implementation/qualification/release sequence. The latest user instruction authorizes consecutive available development lots. Blocked hardware work is recorded without repeated attempts. See its progress table for implemented, partial and pending work; local development does not imply production promotion. Existing authorization, ceilings and autonomous stops remain unchanged.

## Passive development PoP prototype

SSH inventory is available for `ac02` (KVM/x86_64). The [three-Pod passive prototype](../deploy/pop-qualification/README.md) is prepared and checked locally, but cannot be applied using the current account because no Kubernetes context is configured. It is separate from the current Fleet workers and contains no generator. Actual cluster admission, node-label placement, network-policy enforcement and live telemetry acceptance remain pending. Do not install a second cluster or treat the SSH account as a cluster identity.

The application now includes a dated passive-PoP status panel: prepared/staged evidence, pending access, unknown live Pod count and pending acceptance. It exposes no deployment or traffic controls. Publication/promotion must still be distinguished from source readiness.

## Client-first interface

The [simplified workspace](client-first-workspace.md) is implemented in source: overview, three authorized client scopes, pilot infrastructure and the evidence archive. Technical routes and stop controls are preserved. Migration 10 adds versioned client metadata; no fourth client or identity replacement is accepted. Client/report association and live PoP collection remain unimplemented rather than inferred. Production promotion is separate from this source increment.
