# Kubernetes IoT laboratory

The current laboratory has a dedicated HTTP target, three persistent simulated IoT agents, an independent probe, PostgreSQL, control/coordinator services and Prometheus/Grafana. It validates application orchestration before admission to the infrastructure team's cluster. IoT profiles are metadata/bounded HTTP clients, not compromised hardware.

## Mac and Linux

| Aspect           | Mac local cluster                                             | Linux VPS laboratory                                                           |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Tooling          | kind plus a container runtime; repository kind/Calico overlay | Current deployment: k3d container running K3s                                  |
| Purpose          | Development, fixtures and reproducibility                     | Existing three-agent integration and independent private target/probe          |
| Images           | Match workstation architecture; preload pinned images         | Preloaded amd64 images with source identity; do not relabel Mac images         |
| Network evidence | Local container/private IP observations                       | Distinct Pod IPs, one observed public NAT egress                               |
| Limit            | No production or distributed-Internet parity claim            | Shared VPS isolation is not physical host separation or capacity qualification |

Official guidance: [kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/) and [K3s requirements](https://docs.k3s.io/installation/requirements). The repository's release/tool locks record the versions used for its recipes; do not silently install the latest version. Use a kubectl within the supported skew of the API server, preferably its bundled client. See the [Kubernetes skew policy](https://kubernetes.io/releases/version-skew-policy/).

## Repository resources

`deploy/kubernetes/base/` contains namespace, control, database, Fleet, target, probe and policy resources. `overlays/kind/` and `overlays/k3s/` describe laboratory variants. `monitoring/` defines private monitoring. `releases/linux-source-06/` pins observed image provenance; its complete rendered overlay has not been applied wholesale.

Render without deploying:

```sh
kubectl kustomize deploy/kubernetes/releases/linux-source-06 > /tmp/linux-source-06.yaml
node scripts/operations/verify-lab-render.mjs /tmp/linux-source-06.yaml
```

Private identities/database bootstrap, image preloading, actual API discovery, CNI policy enforcement and DNS need environment-specific setup. Never commit Secret values or kubeconfig credentials. Rendering is not a running-cluster qualification.

## Contract and qualification

Kubernetes provisions restricted identities/resources; ShieldTester plans exact agents, sites, authorized origins and shared budgets; workers report commands, timestamps, counters and stop receipts. A Pod Ready flag is not an authenticated heartbeat or a completed mission. Current physical caps stay 3 agents/15 requests per second/concurrency 6/60 seconds; registry 5,000/100 sites is separate.

Check fixed target/probe separation, allowlisted egress, private source observations, clocks, stop acknowledgments, no replay after restart, incomplete evidence and restore behavior. Entry/origin collectors and functional journeys remain required for measured DRS. [Current setup](current-setup.md) lists today's topology; [handoff](infrastructure-handoff.md) lists dependencies before the first team site.
