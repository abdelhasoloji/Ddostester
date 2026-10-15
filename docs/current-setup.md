# Current setup — observed 14 October 2026

This is a dated deployment observation, not a promise that an IP, Pod or release remains unchanged. Check `/health`, service identity and Kubernetes state before an operation. Private credentials and evidence live outside both repositories.

## Hosts and processes

| Host            | Actual role                                                                                               | Access and isolation                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `31.31.74.228`  | ShieldTester control plane, PostgreSQL, API/UI, independent HTTP observation for public Fleet diagnostics | API `127.0.0.1:8080`; Caddy HTTPS with client mTLS; service `ddostester`                  |
| `31.31.74.187`  | Linux HTTP Kubernetes lab and separate synthetic-bench runner                                             | K3s inside k3d Docker container `k3d-ddostester-linux-lab-server-0`; private lab services |
| Mac workstation | Source, development, kind laboratory manifests and private release/evidence archives                      | Local development and isolated tests; no current parity claim with Linux                  |
| `46.28.109.92`  | Dedicated authorized HTTP test target for earlier diagnostics                                             | Admission requires application allowlist, approved origins and worker/network policy      |

The production service is active at `/home/shieldtest/ddostester-releases/drs-engine-bbd4293fb91e/backend`, build 463, source archive SHA-256 `bbd4293fb91e57abda167478b44ab7d9ade4f07f39f730d68e98c17c4799ed2e`. Health reports PostgreSQL, single mode, `single_admin`, DRS workflow enabled, built-in HTTP default. Protection-provider configuration is enabled; target telemetry and remote-probe flags are false. A configured protection provider is not proof of independent DRS protection-entry measurement.

The application has 11 preserved accounts and one administrator, `abdelha@wedos`. There are 281 archived historical campaigns, one retained Fleet draft and one completed offline simulation from the build-463 verification. These counts are the delivery checkpoint, not live counters.

`CAMPAIGN_CATALOG=drs-fleet`, `FLEET_MISSIONS_ENABLED=1`; Fleet origins at the checkpoint are `http://lab-target:8080` and `http://46.28.109.92`. The old Kubernetes Job adapter's `FLEET_ENABLED=0` does not disable persistent Fleet missions. Keep configuration in protected service environment files; never paste their contents into an issue.

## Kubernetes HTTP lab

Namespace `ddostester-lab`; observed server `v1.37.1+k3s1`. Use its matching bundled kubectl for live access. The running node is a Docker container on the VPS, not a standalone system k3s installation.

| Agent        | Profile metadata | Observed private Pod IP |
| ------------ | ---------------- | ----------------------- |
| `lab-iot-01` | sensor           | `10.247.0.71`           |
| `lab-iot-02` | camera           | `10.247.0.72`           |
| `lab-iot-03` | gateway          | `10.247.0.73`           |

All three Pods were Running. Pod readiness does not establish application authentication or campaign eligibility; the Fleet page's fresh authenticated heartbeat is required. Their external HTTP receipts previously showed shared public source `31.31.74.187`; they are not three independent Internet sources.

Ten Pods were present: control, coordinator, database, target, probe, Prometheus, Grafana and three IoT agents. Quota `lab-budget`: Pods 10/16, CPU requests 1125m/4, memory requests 1440Mi/6Gi, CPU limits 5250m/8, memory limits 4352Mi/10Gi, batch Jobs 0/3; NodePort and LoadBalancer Services 0/0. Free Pod slots do not authorize more active agents or demonstrate throughput. Each agent requests 50m CPU/128Mi and is limited to 250m/256Mi.

The source-06 Linux image layer is provenance for the existing HTTP lab, not the production build-463 image. The complete rendered release layer has not been applied wholesale. Auxiliary images and private Secrets/PVCs must be preserved when updating it.

## Separate synthetic network bench

`shieldtest-lab-runner` is active on the lab VPS; `/opt/shieldtest-lab` was observed at `eb0aa26`. This source identity differs from the refreshed repository main. Service activity alone does not prove an active scenario, qualified measurement, or deployment of new documentation/code. The Compose bench and HTTP Kubernetes fleet are separate laboratories.

## Qualification gaps

Kusa endpoints, infrastructure-cluster admission, site agents, independently qualified protection-entry/origin collectors, functional user journeys, calibration and source diversity remain to be connected or demonstrated. No measured full-standard DRS capacity or 5,000-agent execution has been established. See [roadmap](roadmap.md).

## Follow-up observation — 15 October 2026

The control API still reports build 463. The native systemd service currently runs with `User=root`; this is separate from the restricted Kubernetes workload identities. Moving the native API to an unprivileged service account remains work requiring runtime-file/PKI permission and rollback validation. The deployment source checkout `/home/shieldtest/ddostester` was clean at `d98db08`; the active service continues to use its immutable release directory. No claim of a newer deployment is made by this observation.
