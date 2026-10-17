# Passive PoP qualification prototype

Three passive telemetry Pods, separate from the existing IoT Fleet. This package does not relocate or replace the three current workers, enroll in Fleet, execute assignments, expose a Service, or generate target traffic. It logs process/container observations every 30 seconds. Unsupported cgroup fields stay null. It does not measure physical-host capacity, availability of a test URL, or DRS resilience.

The container runs as a non-root user with a read-only root filesystem, dropped capabilities and no service-account token. A default-deny NetworkPolicy is included; its enforcement must be verified with the cluster's CNI. Image pulls are performed by the node and are not governed by the Pod's egress policy. See the official [restricted Pod standard](https://kubernetes.io/docs/concepts/security/pod-security-standards/) and [NetworkPolicy contract](https://kubernetes.io/docs/concepts/services-networking/network-policies/).

## Observed access and prerequisites

SSH to `at264@10.20.2.1` works over the WEDOS VPN. The host reports `ac02`, Ubuntu 24.04.3, KVM, x86_64 and active kubelet/containerd. The user's kubectl configuration has no current context or configured context entries. This package is prepared locally, **not deployed**. No privileged kubeconfig, node credential or Secret has been read or copied.

Before deployment, obtain the intended cluster endpoint/context and scoped permissions for `shieldtest-qualification`. Namespace creation/security labels require an administrator if not already provisioned. Verify the server version/admission rules, the node's actual `kubernetes.io/hostname` label, reserved resources, image registry access and the CNI enforcement. The candidate `ac02` selector deliberately prevents silently placing Pods on an unrelated node; an unmatched selector leaves them Pending.

Total requests: 150m CPU and 192Mi memory. Total limits: 300m CPU and 384Mi memory, plus a 16Mi in-memory scratch volume per Pod (charged to memory). These are proposed namespace reservations, not approved PoP allocations or measured maximum capacity. Recreate strategy avoids exceeding the three-Pod quota during updates.

## Render and future acceptance

Local rendering requires no cluster connection:

```sh
kubectl kustomize deploy/pop-qualification
```

After the above prerequisites are satisfied, an operator can validate the rendered resources against the identified cluster with server-side dry-run, inspect the diff and apply this dedicated package. Do not substitute an unidentified cluster context or install a second cluster on this existing node.

Acceptance requires exactly three Ready Pods on the intended node, advancing JSON sequence/timestamps in each Pod's logs, the expected image digest and resource/security settings, verified deny-all isolation, and unchanged existing workloads. Readiness checks the local telemetry timestamp only; it is not independent measurement or Fleet campaign readiness.

Logs have the kubelet/cluster's retention, not an independent evidence archive. Exporting them through an approved collector and adding application UI integration remain separate work. No cluster permissions, installation or live acceptance are claimed by local rendering and a container smoke test.

## Staged artifact

The rendered, self-contained manifest was copied over SSH to a new private directory at `/home/at264/shieldtest-qualification.huqRvtZK/resources.yml`. Local and remote SHA-256 both equal `c7a27468b098438c5ee4436dd8affa8047504925b481c6468f83f58c186c1144`. No Kubernetes apply, namespace creation or running service was performed. The [checkpoint](local-checkpoint.json) records the three sequential local container samples and this staging receipt. Existing Fleet Pods are unchanged. A future re-render after a source edit produces a new artifact; do not treat this staged hash as applying to modified source.
