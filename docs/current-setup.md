# Current setup — observed 15 October 2026

This is a dated deployment observation, not a promise that an IP, Pod or release remains unchanged. Check `/health`, service identity and Kubernetes state before an operation. Private credentials and evidence live outside both repositories.

## Hosts and processes

| Host            | Actual role                                                                                               | Access and isolation                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `31.31.74.228`  | ShieldTester control plane, PostgreSQL, API/UI, independent HTTP observation for public Fleet diagnostics | API `127.0.0.1:8080`; Caddy HTTPS with client mTLS; service `ddostester`                  |
| `31.31.74.187`  | Linux HTTP Kubernetes lab and separate synthetic-bench runner                                             | K3s inside k3d Docker container `k3d-ddostester-linux-lab-server-0`; private lab services |
| Mac workstation | Source, development, kind laboratory manifests and private release/evidence archives                      | Local development and isolated tests; no current parity claim with Linux                  |
| `46.28.109.92`  | Dedicated authorized HTTP test target for earlier diagnostics                                             | Admission requires application allowlist, approved origins and worker/network policy      |

The production service is active at `/home/shieldtest/ddostester-releases/release-1e3a6f1.HJiE4P/backend`, Git build 455, commit `1e3a6f13429fedb7e219469fa25cbf72f90ddd8c`, verified at 01:51 UTC on 15 October. The earlier archive build 463 used a different counter; compare full source identities rather than treating these two numbering schemes as chronological. Health reports PostgreSQL, single mode, `single_admin`, DRS workflow enabled, built-in HTTP default. Protection-provider configuration is enabled; target telemetry and remote-probe flags are false. A configured protection provider is not proof of independent DRS protection-entry measurement.

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

The source-06 Linux image layer is provenance for the existing HTTP lab, not the production API/UI release. The complete rendered release layer has not been applied wholesale. Auxiliary images and private Secrets/PVCs must be preserved when updating it.

## Separate synthetic network bench

`shieldtest-lab-runner` is active on the lab VPS; `/opt/shieldtest-lab` was observed at `eb0aa26`. This source identity differs from the refreshed repository main. Service activity alone does not prove an active scenario, qualified measurement, or deployment of new documentation/code. The Compose bench and HTTP Kubernetes fleet are separate laboratories.

## Qualification gaps

Kusa endpoints, infrastructure-cluster admission, site agents, independently qualified protection-entry/origin collectors, functional user journeys, calibration and source diversity remain to be connected or demonstrated. No measured full-standard DRS capacity or 5,000-agent execution has been established. See [roadmap](roadmap.md).

## Follow-up observation — 15 October 2026

The earlier observation reported archive build 463; the later delivery above now serves the exact Git commit. The native systemd service currently runs with `User=root`; this is separate from the restricted Kubernetes workload identities. Moving the native API to an unprivileged service account remains work requiring runtime-file/PKI permission and rollback validation. The deployment source checkout `/home/shieldtest/ddostester` was clean at `d98db08`; the active service continues to use its immutable release directory. No claim of a newer deployment is made by this observation.

## Delivery verification — 15 October 2026

[CI for the deployed code](https://github.com/abdelhasoloji/Ddostester/actions/runs/38666811959) passed all four jobs: quality, frontend, backend coverage and PostgreSQL/recovery. The VPS independently passed lint, typecheck, 1,200 backend tests, 455 frontend tests and build. Promotion verified readiness, the full API commit and hashes of every served UI asset. Account and inventory digests, the sole administrator, 283 campaign records and runtime policy were preserved; no campaign was running. All three existing agents resumed fresh authenticated heartbeats and were online after restart. No physical campaign or Kubernetes agent-image rollout was performed. The standalone heartbeat-client fix is in source; this delivery does not claim new agent binaries.

Automatic deployment remains blocked by the runner's release-directory permissions. This delivery used an operator promotion of the exact green CI commit, with the native gates and existing runner privilege restrictions retained. The previous release and encrypted backup are retained outside Git.

## HTTP receipt monitoring — 15 October 2026

The lab monitoring increment is deployed from source `bb30ccf08d5f87e22da6404c70f55e09581322dc`. Prometheus has three healthy jobs (control, self and target receipts); Grafana provisions Run, Resilience, Fleet evidence and HTTP target receipts. The new target-side exporter exposes source-scoped log counters and continuity/read-time gauges. No tagged campaign traffic was generated to populate it; empty campaign series remain unknown. Dashboard provisioning alone does not qualify all legacy Fleet panels. See the [sanitized deployment receipt](monitoring-receipts-checkpoint.json) and [collector contract](observability.md).

The same PVC identities and 39 historical control samples were verified after monitoring restarts; seven unrelated Pods, including the three agents, were preserved. The previous target log was archived privately before its ephemeral volume was replaced. The first operator attempt used an insufficient 100-second Grafana deadline; its rollback also reached that deadline. The previous Grafana configuration subsequently became healthy. A separate retry reused the healthy target/Prometheus rollout and waited up to 300 seconds for Grafana under its unchanged 200m CPU ceiling; all final checks passed. Failure logs and backup evidence are retained privately. This lab delivery does not change the central API/UI release listed above.

## DRS Grafana delivery — 15 October 2026, 09:29 UTC

The central API/UI now serves Git build **459**, commit `088e5f88f4f7b1466a117e00916d7e03618e4de0`, from `/home/shieldtest/ddostester-releases/release-088e5f8.mPrdUO/backend`. All four CI jobs and native VPS lint/typecheck/tests/build passed; served API and UI asset identities matched the release manifest. An encrypted database backup and the previous service definition are retained privately. Account, campaign and settings digests are unchanged: 11 accounts, 283 campaigns and three online Fleet agents. No campaign was launched. The existing sole-admin policy and execution ceilings are preserved.

Two Grafana instances coexist on the lab host. Native Grafana 13.2.1 binds loopback port 3000 and uses native Prometheus on loopback 9090. Its existing SSH transport collects the central application on loopback 8080. Its new `shieldtest-drs` dashboard contains five panels and receives the actual stored DRS revision. The existing simulation score of 1 matches its application report; it is explicitly simulation evidence, not a physical resilience measurement. Native Grafana stores dashboard models in the Grafana 13 unified resource store rather than the legacy SQLite dashboard table.

Kubernetes Grafana 13.2.4 has five dashboards, including the same DRS model, and its own Prometheus retains three healthy jobs. It observes the separate lab control, so a central campaign is not implicitly present there. Only the Grafana dashboard ConfigMap reference changed in this lab rollout; all PVC identities and nine unrelated Pods were preserved. The source control and agent images were not replaced. The Grafana cold start required approximately two and a half minutes under the existing limits.

Run Theater now provides a DRS-specific link scoped to the campaign and frozen revision alongside the generator dashboard. The assessment view covers workflow phase, mode, reference, coverage, validity availability and authoritative score/status. Full correlated physical exposure/recovery timelines and the live Fleet count in Grafana remain subsequent work. See the [delivery receipt](drs-grafana-checkpoint.json) and [observability contract](observability.md).

## DRS workflow and Fleet collection — 15 October 2026

The central API/UI now serves build **461**, commit `fa87aa55b2228877468c1f7d35d240d72b1997a1`, from `/home/shieldtest/ddostester-releases/release-fa87aa5.1kvK5B/backend`. Four CI jobs, native verification and the exact API/UI asset identities passed. Fifty disposable PostgreSQL tests and encrypted recovery passed separately. Eleven accounts, 283 campaigns, settings and three Fleet device identities are unchanged; all three agents were online after restart. An encrypted pre-release database backup and the prior service definition are retained privately. No campaign was launched and no execution limit changed.

Native Prometheus now has five healthy jobs. New jobs collect archived DRS transitions every 15 seconds and read-only Fleet participation every five seconds through the existing loopback SSH transport. Native Grafana provisions dashboard version 2 with 11 panels. The API exposes 16 existing workflow events plus the omission gauge; those observations are the retained engine-validation simulation, not physical exposure. The Fleet endpoint is healthy but existing missions have no frozen-revision binding, so it does not manufacture a zero or participation trace. Future missions capture that binding. PostgreSQL tests enforce read-only collection and check fresh/expired/missing reports; physical campaign qualification remains separate.

The same model is included for Kubernetes Grafana, whose own datasource remains tied to the separate local control image. Provisioning it does not make the new detailed series available in that control. Agent, coordinator, target, probe and control images are preserved. Full physical exposure/recovery correlation, independent ingress/origin evidence, Kusa and increased execution capacity remain open. See the [native delivery receipt](drs-live-checkpoint.json) and [collector contract](observability.md).

## Private Fleet acceptance — 15 October 2026, 11:43–11:54 UTC

Central API/UI build **463**, commit `b8597b52797dad073b080eaf6ac865616f2d5a17`, passed [all four CI jobs](https://github.com/abdelhasoloji/Ddostester/actions/runs/38728152759), native lint/typecheck/tests/build and served asset identity checks. This fixes single-owner confirmation incorrectly treating the stored DRS document as newly supplied client evidence. Frozen-plan integrity and shared budgets remain enforced.

The authorized private acceptance campaign `0ab8b651-953e-458f-9c25-f4b2474ab7c7`, revision `07735fb8-9d50-49bf-8c5b-356f942a9b3f`, requested the three existing agents, shared 3 RPS, concurrency 3 and 30 seconds against `http://lab-target:8080/`. Its unchanged plan required a 300-second stable baseline, bounded at 600 seconds. A temporary loopback SSH/private Docker bridge relay let the central probe reach that dedicated target without a public target port.

**Acceptance did not pass.** Confirmation reached BASELINE, but the baseline guard refused injection at 11:54:18 UTC with `DRS baseline remains unstable, incomplete or cancelled; no injection`. The archived diagnostic reference is `47dae67c-4db0-42a2-b151-8288adbf64f6`. The current failure does not retain the baseline sample distribution, so this receipt cannot identify which final guard condition failed. No Fleet mission was created. Prometheus collected 96 observations without query errors, observed FINAL_REPORT and retained absent participation/receipt series. This is not a verified live bot counter or natural-stop test. The report is INDETERMINATE/PARTIAL with null score and no proofs.

The operator HTTP wait failed after about 300 seconds while the server continued baseline observation and finalized the report independently. Long-running execution acknowledgement/reconnection and useful baseline failure diagnostics remain follow-ups; do not weaken stability thresholds or change a frozen plan to force a pass. The plan retains its original build-461 component declaration; the actual executing release was build 463, so a subsequent revision should capture the current component versions.

Cleanup was verified: temporary target authorization revoked, relay/port-forward stopped, tagged hosts mapping and temporary SSH key removed. Existing monitoring transport remains active. Account/settings hashes and all 283 preceding campaign records are unchanged; the new campaign/report remain archived. Private evidence is retained on both hosts and in the operator's local evidence directory. No public-target traffic, capacity increase, agent rollout or full DRS qualification occurred.
