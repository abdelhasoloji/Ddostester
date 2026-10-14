# Security and authorized operation

ShieldTester tests resilience on infrastructure for which the operator has authorization. Both private and public HTTP targets are supported through explicit allowlist/origin admission, target attestation, bounded budgets and account confirmation. Deployment access uses authenticated TLS/mTLS or protected administrative tunnels.

The separate synthetic network bench has its own confined scenarios and network guard; normal authorized HTTP tests do not inherit a blanket ban on public targets. No arbitrary public amplification or spoofing emitter is enabled in the control plane.

For account policy, secrets, stop controls and audit/evidence provenance, follow [security and governance](docs/security-and-governance.md), [single-user operations](docs/single-user.md) and [current setup](docs/current-setup.md). Keep private credentials outside Git. Report a vulnerability privately to the repository owner; include a bounded reproduction and avoid publishing credentials or directing traffic at third-party systems.
