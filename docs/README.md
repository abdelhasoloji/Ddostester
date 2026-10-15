# ShieldTester documentation

Current product and setup, reconciled on 14 October 2026. The source and `/health` identify implementation and deployed release; [current setup](current-setup.md) distinguishes them. A reference file or passing fixture does not establish a live integration.

| Topic                                             | Read                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and three campaign modes                  | [Overview](overview.md), [Usage](usage.md)                                                                                                            |
| Official reference, scoring and evidence          | [DRS engine](drs-engine.md), [Measurement](measurement.md)                                                                                            |
| Components and contracts                          | [Architecture](architecture.md), [API](api.md), [Server reference](servers/README.md)                                                                 |
| Current hosts, versions and limits                | [Current setup](current-setup.md), [Operations](operations.md)                                                                                        |
| Persistent IoT clients and campaign orchestration | [Fleet management](fleet-management.md), [Fleet missions](fleet-missions.md)                                                                          |
| Kubernetes and infrastructure admission           | [Kubernetes lab](kubernetes-iot-lab.md), [Infrastructure handoff](infrastructure-handoff.md)                                                          |
| Companion synthetic bench                         | [Boundary and lab](boundary-and-lab.md), [Lab assessment](lab-assessment.md)                                                                          |
| Access, safeguards and identity                   | [Security](security-and-governance.md), [Single user](single-user.md), [Owner recovery](owner-recovery.md), [Fleet identities](fleet-certificates.md) |
| Monitoring, comparisons and verification          | [Observability](observability.md), [Run comparison](run-comparison.md), [Testing](testing.md)                                                         |
| Delivery and remaining work                       | [Roadmap](roadmap.md), [Source snapshots](source-snapshots.md), [Versioning](versioning.md)                                                           |
| Contributor instructions                          | [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md)                                                                                      |

Older audit and planning URLs now direct readers to the current contract. Their original content remains in Git history and the requested pre-refresh backup branch. Generated CMDB spreadsheets and line-number inventories from the former deployment are superseded by the current setup and code references.

Infrastructure planning: [RL300 ARM64 / DRS level-5 study](rl300-arm64-infrastructure-study.md), with [source and registry evidence](rl300-arm64-evidence.json). This is a proposal for two-server qualification, not an observed deployment or a validated server count.

Product adaptation: [RL300 roadmap](rl300-product-roadmap.md), [infrastructure workspace and evidence contract](infrastructure-workspace.md), [two-host preparation dossier](rl300-two-host-preparation.json). Local source changes are distinct from the current deployed release.

PoP preparation: [passive three-Pod qualification prototype](../deploy/pop-qualification/README.md), with local checks and explicit cluster-access prerequisites. Not deployed and not a Fleet worker migration.
