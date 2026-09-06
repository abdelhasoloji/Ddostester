# Documentation — WEDOS ShieldTest (Control Plane)

Internal control plane for resilience testing. This folder gathers the technical
and operational documentation.

| Document                                               | Contents                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [architecture.md](./architecture.md)                   | Overview, modules, campaign flow                                 |
| [deployment.md](./deployment.md)                       | Server deployment, systemd, SSH tunnel, updates                  |
| [ci-cd.md](./ci-cd.md)                                 | CI and CD pipelines, deploy secrets, rollback                    |
| [usage.md](./usage.md)                                 | Full walkthrough: create → approve → execute → report            |
| [api.md](./api.md)                                     | REST endpoint reference with `curl` examples                     |
| [auth.md](./auth.md)                                   | JWT authentication, roles (RBAC), separation of duties           |
| [wrs.md](./wrs.md)                                     | Formula and interpretation of the WEDOS Resiliency Score         |
| [audit.md](./audit.md)                                 | Tamper-evident audit chain: verification and export              |
| [roadmap.md](./roadmap.md)                             | Implementation status vs plan (source of truth)                  |
| [safeguards.md](./safeguards.md)                       | Security model, scope, what is not implemented                   |
| [offensive-integration.md](./offensive-integration.md) | Load generation: agents (builtin/k6), governance, external L3/L4 |
| [security-review.md](./security-review.md)             | Security review (threats, verified points, residual risks)       |
| [monitoring.md](./monitoring.md)                       | Prometheus + Grafana (provisioned dashboard)                     |
| [stack-vs-tsd.md](./stack-vs-tsd.md)                   | Mapping of the implemented stack vs the TSD specification        |

> ⚠️ **Defensive scope.** This tool orchestrates, measures and scores **bounded
> HTTP** load tests against authorized infrastructure. It implements **no attack
> vector** (L3/L4 flood, amplification, L7 exhaustion).
> See [safeguards.md](./safeguards.md).
