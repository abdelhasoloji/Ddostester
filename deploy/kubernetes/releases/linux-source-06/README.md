# Linux source-06 image reference

This release layer pins the five application images observed in the private
Linux lab. Control and probe come from source archive
`7e1c8ee4ab35a288322d9e717758611d9613db8a7a72f7e582bb56457a39346e`.
Target, telemetry and PostgreSQL retain their earlier imported images; their
digests were checked against both running Pods and the containerd cache. This
does not claim that all five images were rebuilt from source-06.

Render and inspect without changing a cluster:

```sh
kubectl kustomize deploy/kubernetes/releases/linux-source-06 > /tmp/linux-source-06.yaml
node scripts/operations/verify-lab-render.mjs /tmp/linux-source-06.yaml
```

The verifier needs the repository's installed Node dependencies, including the
pinned js-yaml dev dependency. Offline rendering passed with Mac kubectl 1.32.2 /
Kustomize 5.5.0 and the Linux bundled client / Kustomize 5.8.1; the thirty
resources are byte-identical (SHA-256
`d08d3a1c2854a18e125b832b965759313b693ec642ea46c307fd94811787ace3`).
This does not make the older Mac client suitable for cluster access: the
Linux server and its bundled client are 1.37.1+k3s1, while Kubernetes supports
kubectl within one minor version of the API server. Use the matching bundled
client or a separately verified 1.37 client for live operations, with an explicit
lab kubeconfig. See the official
[version skew policy](https://kubernetes.io/releases/version-skew-policy/).

Kustomize image overrides pin control, coordinator, loopback access, probe,
target, telemetry and database. A replacement copies the rendered control image
into its `FLEET_AGENT_IMAGE` environment variable; a floating tag or a stale
agent digest cannot silently diverge. See the official
[Kustomize documentation](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/).

The verifier checks this release's exact seven container references, singleton
workloads, `Never` pull policy, disabled scheduler and agent/control consistency.
It refuses inline Secrets, unexpected resource kinds, unreviewed init containers,
host namespaces and public Service types. These checks are not a complete RBAC,
CNI, resource-capacity or installation certification.

Do not treat this layer as a one-command lab installer. Generate separate private
identities and PostgreSQL bootstrap, preload these amd64 images into the intended
node, and establish the minimal API egress from its actual endpoint discovery.
Those environment-specific steps are not encoded here. The inherited CoreDNS
ConfigMap also requires explicit review for the selected lab cluster. Use the
cluster configuration and handoff runbooks for those prerequisites.

Only the control/probe image changes have been promoted and tested in the live
Linux lab. The auxiliary deployment specs still use their original local tags;
this new release layer has been rendered and checked, but has not been applied.
Applying it may restart auxiliary workloads and must preserve their evidence and
PVCs. Do not use it against production or the team cluster. Mac images have
different architecture and provenance and must not be relabelled as this release.

Source-06 fleet recipe: three agents completed with 54 matching target receipts,
but the report was inconclusive because of baseline throttling and under-delivery.
An immutable digest identifies an image; it does not establish measurement quality
or infrastructure readiness. Previous image artifacts remain available for rollback.
