# Current setup — latest application observation 16 October 2026

This is a dated deployment observation, not a promise that an IP, Pod or release remains unchanged. Check `/health`, service identity and Kubernetes state before an operation. Private credentials and evidence live outside both repositories.

## Hosts and processes

| Host            | Actual role                                                                                               | Access and isolation                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `31.31.74.228`  | ShieldTester control plane, PostgreSQL, API/UI, independent HTTP observation for public Fleet diagnostics | API `127.0.0.1:8080`; Caddy HTTPS with client mTLS; service `ddostester`                  |
| `31.31.74.187`  | Linux HTTP Kubernetes lab and separate synthetic-bench runner                                             | K3s inside k3d Docker container `k3d-ddostester-linux-lab-server-0`; private lab services |
| Mac workstation | Source, development, kind laboratory manifests and private release/evidence archives                      | Local development and isolated tests; no current parity claim with Linux                  |
| `46.28.109.92`  | Dedicated authorized HTTP test target for earlier diagnostics                                             | Admission requires application allowlist, approved origins and worker/network policy      |

The latest verified production API/UI is Git build **482**, commit `9b8dbbb27e5266a2acdd8fb81295d9109b6e5817`, at `/home/shieldtest/ddostester-releases/release-9b8dbbb2.jQvqiY/backend`, promoted at 05:32 UTC on 16 October 2026. Exact-SHA CI, native lint/typecheck/tests/build, served API/UI identity and external HTTPS health passed. PostgreSQL is ready in single mode. The client prototype journey, JSON/HTML reports, client-filtered archive and conservative read-only A/B comparison are testable. DRS 5 remains an assessment objective, with no measured level established. See the [latest delivery receipt](client-comparison-deployment-checkpoint.json).

At this promotion, all 11 accounts (sole administrator `abdelha@wedos`), 284 campaigns, settings and three Fleet identities were preserved, as were complete historical audit-row and infrastructure-revision digests. The encrypted backup was authenticated and restored into an isolated disposable database. No production campaign or traffic was started, and no Pod was moved. Counts are dated checkpoints, not live counters. The infrastructure/lab observations below retain their earlier dates and are not a fresh cluster qualification.

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

## Baseline reliability delivery — 15 October 2026, 18:32 UTC

Build 465 is verified deployed after [green CI](https://github.com/abdelhasoloji/Ddostester/actions/runs/38785013341) and native gates. It retains bounded baseline refusal diagnostics in the revision/report, reserves request time before scheduling extension batches, and avoids response-time drift in one-second probe cadence. The frontend requests HTTP 202 admission and reconnects through stored status/progress rather than holding the final-result request open. Baseline phase persistence retains RUNNING; failed runs release the in-flight gauge. The old blocking execution contract remains available.

A fresh revision `c9c59be1-a2f3-448b-aa85-9cba740e3e47` of the same private acceptance campaign was frozen with build-465 component provenance, preserving the earlier failed revision. Budgets remain three existing agents, shared 3 RPS, concurrency 3 and 30 seconds; baseline remains at least 300 seconds with CV tolerance 0.1 and an absolute 600-second ceiling. The application acknowledged the actual start with HTTP 202 in 62 ms and persisted RUNNING/BASELINE. The finalized runtime outcome follows below; this admission alone does not validate live participation or a DRS score.

### Build-465 acceptance outcome

Revision 2 finalized at 18:42:49 UTC without creating a Fleet mission. The baseline diagnostic identifies **instability**, rather than cancellation or HTTP failure: 1,197 recorded samples over 590.003 seconds, 100% availability, mean 11.761 ms and coefficient of variation **1.240138** against the unchanged **0.1** tolerance. The complete raw distribution is retained in the private report. JSON/HTML reports preserve this diagnostic and return INDETERMINATE/PARTIAL with null score; the earlier failed revision is unchanged. No live bot count, emitted/received load or natural-stop behavior was validated.

This observation also exposed adjacent probes at extension batch boundaries, particularly when the reserved-time budget reduced the batch size to one. The build-465 sample count must not be presented as proof of exact one-second cadence. A subsequent correction separates the final and first sample across batches, with a timer test covering the boundary; its deployment identity is recorded below.

Independent native Prometheus polling produced 93 observations with no query errors, observed FINAL_REPORT and retained absent Fleet/receipt series. After settlement the temporary target authorization was revoked; loopback relay, private port-forward, tagged hosts entry and temporary SSH private/authorized key were removed. The normal monitoring transport and ten lab Pods remain active. Account/settings hashes and all 283 other campaign records are unchanged. Private raw reports and observations are retained outside Git.

A separate 20-request, low-rate precheck of the existing Kubernetes probe returned 20 successful, fresh v2 responses. Its latency CV was 2.188722 (0.476189 for the 19 observations after the first). This short diagnostic does not qualify a baseline or establish the sole cause of jitter. It shows that swapping the transport alone is insufficient evidence of stability. Probe/target instrumentation and a representative functional reference need qualification before another equivalent campaign; do not lower the frozen tolerance or repeatedly rerun an unchanged unstable setup to force admission.

## Batch-spacing correction — 15 October 2026, 18:58 UTC

Build **466**, commit `8cec20c1ae59bb27135ec0e9fbfeb063a6985081`, is verified deployed. All four CI jobs, native lint/typecheck, 1,224 backend tests, 458 frontend tests and compilation passed. Served API/UI asset identities match. It corrects adjacent probes across extension batch boundaries, including one-sample batches near the deadline. A fake-clock test verifies the continuous one-second spacing across two consecutive batches. The observation ceiling, plan tolerance, approval and generation budgets remain unchanged.

Promotion preserved accounts, settings, all 284 campaigns and three Fleet identities; all agents are online. Ten lab Pods remain Running and all five native Prometheus jobs are healthy. Old immutable releases and encrypted backups remain available. The full physical campaign was not repeated on build 466: the observed build-465 instability and separate probe precheck require instrumentation qualification before an equivalent repeat. Live participation, independently received Fleet traffic, natural stop, agent-loss and emergency-stop acceptance remain unqualified. See the [sanitized receipt](drs-baseline-checkpoint.json).

## Local infrastructure product increment — 15 October 2026

The source now includes the [infrastructure workspace](infrastructure-workspace.md): versioned physical-host profiles, an operator evidence register for a selected pair, DRS level-5 capability gaps and baseline-refusal distributions. PostgreSQL migration 9 adds a separate append-only revision table. It has been exercised only on disposable local storage. These changes do not alter the running production checkpoint, deploy agents, change traffic limits or qualify the HPE estate. No external operation was performed for this increment.

## Development PoP access — 15 October 2026

WEDOS VPN SSH access to `at264@10.20.2.1` was verified read-only. Host `ac02` reports Ubuntu 24.04.3 LTS, kernel 6.8.0-100-generic, KVM virtualization and x86_64, with 255 visible logical CPUs, approximately 755GiB RAM and a 3.4T root filesystem. These are VM-visible resources, not an exclusive allocation or proof of the physical host's core count. This is not native RL300 ARM64 qualification.

Containerd and kubelet are active, and Cilium interfaces are present. The user's kubectl client is v1.32.0; this does not establish the API server version or health. No current/configured Kubernetes context is available for `at264`. No privileged kubeconfig or node identity was accessed. Cluster admission, reserved resources and the intended namespace remain unverified.

A [passive qualification prototype](../deploy/pop-qualification/README.md) is prepared locally: three proposed telemetry Pods, no traffic generator, Fleet enrollment or external collector. Local rendering and isolated-container samples are not a live deployment. The existing three Fleet workers are unchanged; no second cluster was installed on the PoP.

The rendered passive manifest is staged, not applied, in a new private directory under `/home/at264/shieldtest-qualification.huqRvtZK/`. The local and remote artifact hashes match; see the prototype checkpoint for provenance. No remote service, package, Kubernetes resource or Fleet workload was changed.

## Client-first workspace deployed — 15 October 2026, 22:09 UTC

Build **475**, commit `5d316ed70d493a239d4e844300bd17fb0dd4d54f`, is verified deployed on the application VPS. All four CI jobs and the native verification gate passed; served API/UI identity and external HTTPS health match. PostgreSQL readiness and migrations 9–10 are confirmed. This supersedes the earlier build-466 application checkpoint.

The interface presents Overview, Clients, Infrastructure and Evidence archive, with exactly bank.cz, ENISA preproduction and the test VPS. Metadata edits are audited revisions; client identity does not grant a URL permission. The two-PoP pilot plus independent probe remains a planning hypothesis. ENISA's hostname remains unspecified.

Before promotion, an encrypted database backup was authenticated and restored into an isolated disposable database. After promotion, fingerprints for all 11 users, 284 campaigns, settings and three Fleet identities remain identical; the previous audit prefix and sole-administrator policy are preserved. Runtime target policy and traffic ceilings are unchanged. Previous immutable release and service definitions are retained for rollback. See the [sanitized receipt](client-workspace-deployment-checkpoint.json).

No campaign was started, no worker moved and no PoP manifest applied. The new API's authentication guard was checked in production; authenticated client editing was verified locally with PostgreSQL, not through an impersonated production session. Deployment used the exact green feature-branch commit; PR #218 remains unmerged.

## Testable client prototype deployed — 15 October 2026, 22:57 UTC

Build **478**, commit `9404f8d1c34f594283a539bbf6d33b5e3655c3be`, supersedes build 475 on the application VPS. Exact-SHA CI (all four jobs), the native verification gate, served API/UI asset identity, HTTPS health and PostgreSQL readiness passed. Preparation ran alongside CI; promotion required both completed gates. The previous immutable release and service files remain available for rollback.

Each client now offers a persisted prototype campaign: create, freeze, explicitly confirm simulation, inspect Run Theater, finalize and download JSON. Reports retain the server-captured client scope revision. Healthy, outage, generator-saturation and telemetry-gap fixtures exercise the engine through level 5; missing conditions retain partial/indeterminate outcomes. Short primary labels and keyboard/touch/hover help replace long explanatory paragraphs; journals and reservations are collapsed. The measured client score remains unevaluated.

The complete flow, reload resume, JSON download and mobile help were exercised in an isolated Chrome fixture. Production was checked for exact API/UI identity and authentication guard, not through an impersonated authenticated browser session. All 11 accounts, 284 campaigns, settings and three Fleet identities retain their pre-release fingerprints. Complete prior audit-row and infrastructure-revision digests are unchanged, as are target policy and traffic limits. An authenticated encrypted backup was restored into an isolated database before promotion. No campaign or traffic was started on the production system, and no Pod was moved. See the [sanitized receipt](client-prototype-deployment-checkpoint.json). PR #218 remains unmerged; the deployed application is the exact green feature-branch commit.

## Client archive and HTML reports deployed — 16 October 2026, 04:16 UTC

Build 480 adds client-filtered prototype history in Evidence archive, explicit read/loading failures, resume/open-report links and authenticated standalone HTML export. Archived assessments remain consultable with mutation controls disabled. DRS mode folds technical exports and physical run history and hides the assistant dock on this primary page. Mobile rows keep the report action visible, with date and simulation mode below the client name.

The complete flow, client filter, archive-to-report navigation, reload resume and JSON/HTML download passed in isolated Chrome desktop/mobile fixtures. Exact deployed source, asset hashes, authentication guard, readiness, historical content and unchanged traffic/identity policy were checked after promotion. Production interaction was not exercised through an impersonated authenticated session. Previous immutable releases and private service definitions remain available for rollback. See the [sanitized receipt](client-archive-deployment-checkpoint.json). PR #218 remains unmerged; the application runs its exact green feature-branch commit.

## Client assessment comparison deployed — 16 October 2026, 05:32 UTC

Build 482 adds a collapsed Compare assessments section after choosing a client in Evidence archive. Select two distinct finalized simulations with matching client scope revision/hash, frozen plan and reference. Report revision identity is checked against saved metadata; stale or incompatible reports are refused. Archived reports remain eligible for read-only comparison. The compact level table retains unknown/missing outcomes, and a numeric score change requires two COMPLETE reports with finite scores. This is a simulation comparison, not measured resilience.

Two healthy/outage prototype flows and the archive comparison passed in an isolated Chrome fixture on desktop/mobile. Partial scores remained indeterminate and all mobile A/B/unknown columns remained visible. The archive's mobile column-hiding styles are scoped to its own table. All four CI jobs and the native gate passed on the exact deployed commit. API/UI identity, external HTTPS, PostgreSQL readiness, authentication guard and complete historical digests were verified after promotion. The encrypted archive was also authenticated and restored into an isolated database with matching audit and client/infrastructure revision content.

Accounts, campaigns, settings, three Fleet identities and operational policies are preserved. No production campaign, traffic or Pod migration was started. Production interaction was not tested through an impersonated authenticated browser session. Previous immutable releases and service definitions remain available for rollback. See the [sanitized receipt](client-comparison-deployment-checkpoint.json). PR #218 remains unmerged; the application runs its exact green feature-branch commit.
