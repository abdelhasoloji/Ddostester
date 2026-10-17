# RL300 ARM64 infrastructure study for DRS 3.0

Status: infrastructure study only, 15 October 2026. No HPE host access, deployment, campaign, NIC change or traffic-capacity measurement was performed. **Neither 16 servers nor any other production server count is validated.** The first physical qualification stage is two servers. This document is an engineering proposal, not a Red Button certification.

## Requirements and evidence boundary

| Item                                                                     | Basis                                                | Qualification status                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 20 HPE RL300, Ampere Altra Max, ARM64, 128 cores and 1 TB RAM per server | User-supplied estate description                     | Actual serial/SKU, installed CPU/RAM, usable resources and support matrix not inspected           |
| Management over VPN                                                      | User requirement                                     | Interface, routes, VPN reachability and control endpoint not inspected                            |
| Test traffic over distinct interfaces with direct egress                 | User requirement                                     | NIC models, link rates, routing, public addresses, provider limits and entry observations unknown |
| DRS 3.0; initial objective level 5                                       | User requirement and pinned `standards/drs/3.00.00/` | Objective, not achieved coverage or a sizing guarantee                                            |
| First qualify two servers; scale from measurements                       | User requirement                                     | No two-server performance results yet                                                             |
| Preserve authorized targets, limits and automatic stops                  | Mandatory acceptance constraint                      | No runtime/configuration changes made by this study                                               |

[Machine-readable evidence](rl300-arm64-evidence.json) records inspected commits, file hashes, line anchors, dependency checks and registry observations. Static findings, supplier documentation, published image availability and native execution are separate evidence classes. macOS ARM64 checks do not certify Linux ARM64 or the RL300.

## Compatibility assessment

| Component                                                         | Verified observation                                                                                                                              | Adaptation / remaining proof                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control API and persistent IoT worker                             | TypeScript/JavaScript; active `fleet` resolves to `PersistentFleetHttpAgent`, not the older Kubernetes Jobs adapter                               | Native Linux ARM64 install, build, tests and process/container restart on each pilot host                                                                                 |
| Production npm dependencies                                       | Fresh lockfile install with development dependencies and install scripts omitted; existing portability scanner found no native addons/executables | This was an isolated macOS ARM64 inspection; repeat on Linux ARM64 and inspect exact image contents                                                                       |
| Frontend build                                                    | Lockfile includes Linux ARM64 esbuild and glibc/musl Rollup variants                                                                              | Build on a supported builder; dev-tool binaries must not leak into runtime                                                                                                |
| Pinned Node, PostgreSQL, PHP target, Prometheus and Grafana bases | Public registry index bytes match all five pinned digests; each includes a Linux ARM64 manifest                                                   | Rebuild application images from the inspected source and attest target architecture, startup and health; availability is not a passing native test                        |
| Docker build                                                      | Builder uses `$BUILDPLATFORM`; runtime has a portable-dependency assertion                                                                        | Publish independently verified platform manifests/digests; no relabelling of an existing amd64 image                                                                      |
| Existing Linux lab automation                                     | Host creator rejects non-x86_64; exporter/importer and k3d lock assume amd64                                                                      | Add reviewed architecture-aware tool locks, builders and import verification, or use an infrastructure-managed native ARM64 cluster instead of reusing this VPS bootstrap |
| Optional external HTTP engines                                    | Provisioner branches on ARM64, but pins older tool versions; those tools are not the active persistent-worker path                                | Pin versions/checksums and validate ARM64 runtime dependencies only for tools actually selected; do not treat installer architecture branching as qualification           |
| Companion synthetic bench                                         | Node-based containers use a different, unpinned `node:26.8-alpine` tag; real L3 backend is disabled                                               | Separate native image qualification and immutable pins; its simulation results cannot close physical DRS vector gaps or provide a public reflection path                  |
| CI                                                                | Current jobs target generic `ubuntu-latest`; no explicit native ARM64 matrix is declared                                                          | Add native ARM64 validation with disposable PostgreSQL and image smoke checks, retaining existing quality/coverage gates                                                  |

Node 22 documents GNU/Linux ARM64 support for its specified kernel/glibc baseline. The current application Docker base is Alpine/musl: do not transfer the glibc support classification to that image. K3s documents ARM64 availability, which does not qualify the repository's amd64-specific provisioning scripts. See the official references below.

## Proposed Kubernetes architecture

Use the team's existing control-plane/HA service on the VPN if available. Place the two RL300 pilot nodes in a dedicated worker pool with explicit Linux/ARM64 scheduling, restricted workload identities, quotas, pinned image digests and persistent agent identity/sequence state. A two-node etcd deployment must not be presented as a fault-tolerant quorum; a self-managed HA control plane needs a separately designed quorum/datastore. Do not expose Kubernetes API, database or node-control ports on test interfaces.

Logical paths:

- Management: operator/control API → VPN → infrastructure Kubernetes control plane; workers initiate authenticated HTTPS/mTLS polling and progress to the approved management endpoint.
- Test data: selected worker → approved data-plane route/interface → explicitly authorized target/protection entry. No test-data route should use the management VPN as a fallback.
- Evidence: independent user probe, actual protection-entry/target/origin measurements and central collection correlated by campaign, frozen revision, run, agent and site. Preserve clocks, raw observations, gaps and source identity.

The worker does not currently bind a NIC/source interface in its campaign contract; OS/CNI routing selects the path. NetworkPolicy filters permitted traffic but does not select a NIC or prove a source address. Infrastructure must supply an auditable routing/CNI design enforcing the two paths and their failure behavior. Do not solve this by granting every worker host networking, host privileges, unrestricted egress or network-administration capability. If a secondary network attachment is selected, qualify that plugin's policy enforcement independently; default-interface policy coverage must not be assumed.

Treat worker-source/site identity separately from transport addresses. VPN addresses identify management endpoints; private Pod addresses identify local workloads; the destination observes the actual public egress addresses. NAT may collapse multiple agents, nodes or NICs into one source. Public source diversity is established at the authorized receiver/protection entry, not by Pod count or configured address lists.

## Network and host inventory required before the pilot

For each of the two servers, retain a dated, sanitized inventory with private originals outside Git:

- Actual product/SKU, CPU architecture/model and online cores, RAM, NUMA topology, firmware, storage, OS/kernel/libc, container runtime and Kubernetes/CNI versions.
- NIC vendor/model, PCI identifiers and placement, driver/firmware, physical port mapping, negotiated link/duplex, MTU and installed optics/cabling. Obtain exact adapter-specific HPE and OS support documentation after identifying the SKU.
- Management VPN address/interface and allowed control destinations; data interfaces, permitted routes, source address selection and source-based routing requirements. Check host and Pod paths separately, including DNS resolution.
- Allocated public IPv4/IPv6 prefixes, whether assigned or routed, gateway/SNAT ownership, NAT/connection limits, upstream committed/shared bandwidth and provider-approved test perimeter. No public IPs are inferred from the server model.
- Counter provenance: host/NIC drops and errors, interface bytes/packets, worker requested/emitted observations, independently received measurements and probe health. Keep units and layer definitions separate; negotiated link speed is not measured usable application throughput.

Inventory may use read-only `lscpu`, OS release/kernel data, PCI/driver inspection, `ip -j link/address/route/rule`, `ethtool` information/statistics and Kubernetes node/Pod descriptions. This study supplies no command that changes routing, offloads, queues, quotas, addressing or traffic limits. Never commit kubeconfig credentials, private keys or tokens.

## Distributed control adaptations

Reuse enrollment, exact device selection, site metadata, shared campaign budgets, leases, stop receipts, revision binding and independent read-only metrics. Persistent missions do not require exposing Kubernetes API access to every worker. The older Job adapter and its RBAC do not constitute a new multisite provisioning service.

Required qualification/adaptations:

1. Replace lab-specific image/configuration paths with versioned deployment inputs and native ARM64 image receipts; retain trusted allowed origins and managed credentials.
2. Prove two-host placement and selected-agent identity. Registry tests with 5,000 devices/100 sites do not prove 5,000 active workers, control throughput or public-source diversity.
3. Exercise prepare/start fencing, duplicate requests, late/stale commands, revocation, process/node restart, VPN partition and expired lease. A missing heartbeat is not a positive stop acknowledgment; confirm cessation independently at the target.
4. Preserve one shared rate/concurrency envelope across nodes and sites, not a full campaign budget per server. Audit requested, allocated and observed budgets. Keep current immutable ceilings unchanged.
5. Persist/reconcile campaign and evidence state across control/worker failures. Establish source clock uncertainty, collector completeness and retention before claiming a measured outcome.

Current Fleet ceilings are three selected agents, aggregate 15 RPS, concurrency six and 10–60 seconds. A functional two-host pilot can remain within those limits; it is not a maximum-throughput benchmark. Any later capacity-profile change requires its own explicitly authorized, versioned implementation and qualification; merely increasing constants is not an adaptation plan.

## DRS level-5 gap

Keep the pinned 3.00.00 PDF/catalogue/interpretation profile and per-row requirements immutable. Trace the full required progression through the intended level, services, combinations, duration, source properties, functional behavior and recovery to the actual catalogue rows. Do not apply a level summary indiscriminately to every vector or infer required public IP counts from maximum bot counts.

The current persistent Fleet implements bounded HTTP GET. The physical orchestrator also rejects unsupported vector IDs; its implemented path is not a complete level-5 adapter set. Missing physical vectors, independent collectors, functional assertions, calibration or evidence remain partial/indeterminate. The synthetic bench and disabled real L3 backend do not supply those missing physical capabilities. Adapter/collector coverage must be designed and reviewed separately; this study adds no packet emitter or amplification path.

Existing private acceptance was refused despite 100% availability because its baseline CV was 1.24 against the frozen 0.1 tolerance. See [receipt](drs-baseline-checkpoint.json). Qualify the reference measurement chain before repeating, without relaxing the plan to force a pass. A short low-rate pilot is neither full DRS persistence nor a Red Button certification.

## Qualification of the first two servers

| Gate                      | Required evidence                                                                                                                             | Acceptance / decision                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A — inventory             | Two dated host/NIC/network inventories and declared owner/OS support                                                                          | Missing hardware/network facts remain unknown; no capacity decision                                         |
| B — native software       | ARM64 image manifests, source hashes, native build/tests, disposable database and startup/restart receipts on both hosts                      | No emulation-only or amd64-image evidence presented as native execution                                     |
| C — path separation       | Read-only routing checks and authorized low-rate receiver observations from actual Pods; management/data failure cases                        | Approved destination, correct interface/public-source mapping; no VPN data fallback or broadened egress     |
| D — bounded orchestration | At least one selected agent on each host, shared bounds within existing ceilings, no-fallback behavior, stop/lease/partition/restart evidence | Every selected agent attributable; observed stop or explicit uncertainty; no silent replay                  |
| E — measurement           | Stable reference, independent user/entry/origin measurements, time/units calibration and archived raw evidence                                | Gaps/saturation/unsupported vectors cannot become PASS                                                      |
| F — capacity decision     | Workload-specific sustained measurements within the separately approved envelope, repeatability, resource/collector limits and uncertainty    | Only measured conditions may support sizing; current low ceilings cannot establish a level-5 capacity claim |

No gate is marked executed by this study. Freeze target scope, allowed origins, budgets, duration, stop conditions and operator ownership before a future pilot. Exercise control-path failure by stopping an already bounded authorized test; do not disable its autonomous deadlines or leases.

## Decision on the server count

**16 servers is an unvalidated hypothesis.** Twenty servers describe available inventory, not validated usable capacity. Core/RAM totals and NIC names alone do not determine transaction processing, received traffic, diverse sources, persistence, simultaneous vectors or end-to-end resilience.

After the two-server qualification, record per-workload results, repeatability, shared network/control/storage/collector bottlenecks, failure reserve and uncertainty. Two identical hosts cannot establish scaling across every site, NIC variant or network path. Validate additional representative placements in stages before accepting a production count. Do not extrapolate measurements taken under the current tiny execution envelope to an unmeasured full-standard traffic level. A missing required vector remains a capability gap regardless of server count.

The capacity decision must name its workload/profile, actual source and receiver conditions, covered/missing DRS dimensions, limiting resource, evidence hashes and approved operating envelope. Until that decision is reviewed against measured results, neither a 16-server purchase/deployment plan nor level-5 readiness is confirmed.

## Official references checked for this study

- [HPE RL300 Gen11 QuickSpecs](https://www.hpe.com/psnow/doc/a50004294enw) and [example M128-30 product configuration](https://buy.hpe.com/us/en/Compute/Rack-Servers/ProLiant-RL300-Servers/ProLiant-RL300-Server/HPE-ProLiant-RL300-Gen11-M128%E2%80%9130-3-0GHz-128%E2%80%91core-1P-128GB%E2%80%91R-8SFF-1x480GB-M-2-SSD-800W-PS-Server/p/P76339-B21): platform support and example SKU; not the user's installed NIC/RAM inventory.
- [Node 22 supported platforms](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list): version-specific OS/libc/architecture support.
- [K3s requirements](https://docs.k3s.io/installation/requirements): ARM64 availability, datastore/network prerequisites; no claim of workload throughput.
- [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/): build platform and target images; registry observations in the evidence file identify the exact pinned manifests inspected.
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/): plugin-dependent traffic enforcement, distinct from routing/source-identity proof.
- [Pinned official DRS source](https://www.ddosresiliencyscore.org/wp-content/uploads/2026/08/DDoS-Resiliency-Score-Standard-3.0.pdf): local original hash and interpretation provenance remain in the immutable [manifest](../standards/drs/3.00.00/manifest.json).
