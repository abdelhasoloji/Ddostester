# Current implementation and remaining work

Reconciled against source and build 463 on 14 October 2026. This is the status authority; older plans and audits are not deployment claims.

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
