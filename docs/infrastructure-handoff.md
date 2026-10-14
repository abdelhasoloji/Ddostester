# Infrastructure and Kusa handoff

The current application can register 5,000 devices/100 sites; it does not execute that many workers. Begin infrastructure qualification with one site of 50 registered workers while retaining the application's existing physical execution ceilings until a reviewed capacity profile is implemented and measured.

Request a versioned Kubernetes access contract: dedicated namespace, least-privilege service account, supported API/client versions, CNI/NetworkPolicy enforcement, node/Pod/service CIDRs, quotas/limits, image registry/digests, PVC/backup policy and operator ownership. Keep kubeconfig tokens and certificate keys outside Git.

Request explicit target authorization and approved origins; private address uniqueness within a site; observed egress/SNAT and public-source mapping; DNS, clock synchronization and independent monitoring paths. Fifty private Pods behind one NAT source are not fifty public sources. Public addressing decisions remain with infrastructure.

For Kusa, obtain official API/schema/authentication documentation, collector endpoints, protection-entry and origin metrics, timestamp precision, scrape cadence, functional user journeys, calibration and failure/maintenance semantics. A name or configured endpoint is not qualified integration.

Before admitting traffic, demonstrate bounded dispatch, shared budgets, stop acknowledgment, identity revocation, certificate/key rotation, partition/agent loss/restart handling, no replay, target receipt reconciliation and report finalization on failure. Preserve failed attempts and telemetry gaps. Source identity and archive reproducibility are required.

No cluster-admin entitlement, unconstrained egress, public reflector or arbitrary packet generator is needed for this architecture. Kubernetes provisioning remains operator-managed today. See [current setup](current-setup.md), [mission contract](fleet-missions.md) and [roadmap](roadmap.md).
