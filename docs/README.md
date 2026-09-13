# Documentation — WEDOS ShieldTest (control plane)

Internal control plane for **resilience testing**: it orchestrates, governs,
measures and scores **bounded HTTP** load against authorized infrastructure. It
implements **no attack vector** (see [boundary-and-lab.md](./boundary-and-lab.md)).

The docs are organised into a small set of **topic hubs** (below) plus a
code-anchored reference. Start with [overview.md](./overview.md).

> **Sourcing convention.** Every non-trivial claim in these docs points to where
> it is true — a `path` or `path:line` in the repo, or a screenshot. If a doc and
> the code disagree, the **code wins**; fix the doc in the same PR. The
> [roadmap](./roadmap.md) is the single source of truth for built-vs-planned.

## Start here

| Doc                                  | What it covers                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [overview.md](./overview.md)         | What ShieldTest is & why (the proving ground for WEDOS Protection), the stack-vs-TSD mapping, defensive scope |
| [usage.md](./usage.md)               | End-to-end walkthrough: create → approve → execute → report                                                   |
| [architecture.md](./architecture.md) | Components, backend modules, campaign lifecycle, kill switch, stack                                           |

## Security, governance & boundary

| Doc                                                        | What it covers                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [security-and-governance.md](./security-and-governance.md) | Safeguards, JWT/RBAC & user lifecycle, tamper-evident audit chain, security self-review, secret rotation                         |
| [boundary-and-lab.md](./boundary-and-lab.md)               | What is _not_ implemented & why, the load engines, the class A/B/C policy, the governed read-only contract with `shieldtest-lab` |
| [lab-assessment.md](./lab-assessment.md)                   | Lab état-des-lieux + expansion plan (E7): the `shieldtest-lab` bench's capabilities, limits and how to extend it                 |
| [engine-strategy.md](./engine-strategy.md)                 | Load-engine keep/drop decision + maximising out-of-process usage (E8)                                                            |

## Measurement & reporting

| Doc                                            | What it covers                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [measurement.md](./measurement.md)             | WRS formula & levels, the bounded-DRS assessment methodology + scenario catalogue, the five-phase engagement model, the tune-and-replay loop |
| [pretest-p26-20371.md](./pretest-p26-20371.md) | The zeroBS P26-20371 L7 line-by-line mapping (reference record)                                                                              |

## Operations

| Doc                                    | What it covers                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [operations.md](./operations.md)       | Install/run, CI/CD (self-hosted runner, rollback), the 2-VPS topology, the go-live checklist, public/networked hardening (mTLS, CISO dossier), the ops runbook |
| [observability.md](./observability.md) | `/metrics`, the 3-plane Grafana model, structured logs, alerts, Loki, app-native charts, notifications                                                         |

## Reference

| Doc                                                                                                                        | What it covers                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [api.md](./api.md)                                                                                                         | REST endpoint reference with `curl` examples                                       |
| [servers/](./servers/README.md)                                                                                            | Code-anchored server reference: API, generator, bench, connectors, store, frontend |
| [testing.md](./testing.md) · [functional-test-catalog.md](./functional-test-catalog.md) · [test-catalog/](./test-catalog/) | Test strategy, the functional catalogue and its generated results                  |
| [roadmap.md](./roadmap.md)                                                                                                 | Implementation status vs plan (**source of truth**)                                |
| [versioning.md](./versioning.md)                                                                                           | SemVer + Conventional Commits, the generated CHANGELOG, tag-driven releases        |
| [cmdb/](./cmdb/)                                                                                                           | Configuration-management database build script + export                            |

> ⚠️ **Defensive scope.** This tool orchestrates, measures and scores **bounded
> HTTP** load tests against authorized infrastructure. It implements **no attack
> vector** (L3/L4 flood, amplification, L7 exhaustion). See
> [boundary-and-lab.md](./boundary-and-lab.md).
