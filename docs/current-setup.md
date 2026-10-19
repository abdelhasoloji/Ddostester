# Current setup — observed 18 October 2026

## Operator review between steps — source, 18 October 2026

Legacy HTTP suites launched from the UI now pause between runnable steps. Theater exposes pause/resume and unstarted-step parameter editing with current server bounds and phase totals. Saves invalidate approvals, are audited transactionally and require renewed approval or exact-budget owner confirmation. Active steps, historical runs and frozen DRS/Fleet plans remain protected. See [contract and local acceptance](qa/step-review-2026-10-18/README.md). Not yet deployed; verified production remains build 496.

## Ten focused code reviews — source, 18 October 2026

Six defects corrected across CSV export security, metric catalogue validation, memory transaction lock release, monitoring series identity, non-finite monitoring observations and optional PDF fallback. Shared CSV protection and snapshot field inventory reduce duplication. See the [ten-review record](qa/code-review-10-2026-10-18.md) for inspected paths, tests, unchanged policies and remaining limitations. This source work is not yet deployed; production remains build 496.

## Report evidence coverage follow-up — source, 18 October 2026

The consolidated report now distinguishes planned scenarios from retained run evidence in its cover and summary. Inconclusive scenarios are no longer universally described as rate shortfalls: missing evidence and execution failures remain distinct in their details. A retained run must match both the campaign's run ID and campaign ID before it contributes to the report. Production remains verified build 496 until this source increment passes delivery gates. No generators, traffic limits, accounts or Pods change.

## Current release and measurement consistency — 18 October 2026

Production delivery is verified as build **496**, commit `e1d6b126a2ebd1c91c093c346c9439fdaeabbe89`, promoted at 16:39:52 UTC. The [delivery receipt](qa/report-theater-consistency-2026-10-18/deployment.json) records matching API/UI identity, four green exact-source CI jobs, authenticated backup recovery, preserved history and three unchanged Ready Pods. Single-owner policy and the legacy campaign catalogue are unchanged. Older release statements below are historical observations, not the current release.

The deployed increment shares interval-rate, finalized-failure and probe-observation transformations between Theater and individual/suite reports. Missing counters/reset intervals break curves; monitored checks are dots rather than continuous uptime. Historical cumulative data remains explicitly labelled. The [five-pass review](qa/report-theater-consistency-2026-10-18/five-pass-review.md) distinguishes verified behavior from external prerequisites.

The twelve-step historical suite has eight retained runs and four missing engine reports. Re-rendering those observations does not replay the generators or establish DRS 5 coverage. Physical qualification still requires independent received-load evidence, functional journeys, recovery and calibrated capacity.

Rancher admission remains unavailable from this workstation at this checkpoint: `rancher.wedos.global` resolves to `10.20.0.252`, routed through `en0` via the home gateway; TCP/443 timed out and no local Kubernetes context exists. No ac02 deployment was attempted. Browser permission for the production application remains a separate unresolved constraint.

## Individual Run Theater graphs — 18 October 2026

Source now provides four compact graph cards, an evidence-aware catalogue, individual expanded views, pause, custom time ranges, URL/series filters, CSV and campaign-scoped links. Interval rates use counter differences; probe checks are observed points, and latency remains explicitly cumulative. Missing instrumentation stays unavailable. Live and retained replay share the same renderer. No account, execution-limit or Pod configuration changes. Local journey and delivery status: [acceptance record](qa/run-graph-explorer-2026-10-18/README.md).

## Full ZeroBS suite check — 17 October 2026

The isolated 12-step original-duration suite was attempted once: four completed runs, four automatic availability stops and four k6 output-budget failures. All approval/execution bounds remained in force. The consolidated report has four inconclusive rows, but incorrectly renders missing measurements as zero; engine failures also remain APPROVED/queued in campaign tracking. This is not a validated full suite. Target health recovered and three Pod identities/readiness are preserved. Production stays build 476; the UI simplification remains local source. See [evidence and defects](qa/zerobs-full-2026-10-17/README.md).

## Campaign interface simplification — source preview, 17 October 2026

Campaigns now opens the template catalogue as its sole creation surface. History and assessment evidence have separate tabs. Legacy launch/plan/guide URLs land on templates; Fleet configuration is a template continuation, and selected DRS profiles retain their configuration handoff. Synthetic dispatch is offered in the template catalogue; Theater and Settings retain results and link back to templates instead of creating campaigns. Template and composed-suite creation return to history. No backend authorization, approval, traffic limits, scenario definitions or production data change.

Navigation/theme controls use monochrome outline icons. Template summaries and generator explanations use keyboard-focusable help tips; required target/budget and confirmation information remains visible. Cards have restrained borders and no decorative shadows. The assistant starts collapsed when no saved preference exists. This increment is a local source/visual preview, **not deployed**; production remains build 476.

## Synthetic reporting correction — 17 October 2026

Source now refreshes bench coverage alongside polled run results, renders TCP opened/accepted/refused/peak/capacity counters in individual reports, and separates network evidence from HTTP WRS in aggregate conclusions. Empty HTTP periods no longer render a zero score; network saturation and unmitigated-baseline outcomes are counted without declaring targets clean. Bench evidence respects report period filters and adverse historical observations remain in the conclusion. No execution limits, accounts, generators or Pod definitions changed. Delivered build **476**, commit `b862610d5d0dc1985187302b73eaf643d900d913`, at 12:52 UTC. Full local/native gates and all four exact-source CI jobs passed, including PostgreSQL and recovery. The isolated lab replay completed 12/12 supported scenarios; live Theater coverage reached 12 without reload, all reports matched retained evidence, and the aggregate correctly showed three TCP saturation outcomes and nine unmitigated UDP baselines. Production API/UI identity, readiness, sole admin, 11 accounts, 289 campaigns, settings, audit and three online agents were preserved. No production campaign was launched. See [acceptance](qa/synthetic-reports-476-2026-10-17/README.md) and [deployment receipt](qa/synthetic-reports-476-2026-10-17/deployment.json). Six out-of-model scenarios remain unexecuted; no physical DRS qualification is claimed.

## Synthetic bench replaces HTTP qualification — 17 October 2026

Delivery verified at 11:41 UTC: API/UI build **473**, commit `0e43cea0b5055806f71dbf337365b8dc4279f9ce`, immutable release `/home/shieldtest/ddostester-releases/release-0e43cea.BKdKp8`. All four exact-source CI jobs, native verification and authenticated encrypted restore passed. HTTPS/mTLS and readiness passed; sole admin, 11 accounts, 289 campaigns, settings, audit and three online Fleet identities are preserved. All three Pod UIDs are unchanged. No production campaign was launched. See [deployment checkpoint](synthetic-bench-deployment-checkpoint.json). Browser visual acceptance remains the separate limitation described below.

The operator selected the existing bounded synthetic network bench instead of further GET throughput qualification. Run Theater now exposes `/theater?mode=synthetic`, reusing the governed bench catalogue, dispatch and result polling. Completed rows show actual received packets and Mbit/s separately from the amplification ratio, and link a dedicated authenticated HTML/PDF report at `/api/bench/runs/:id/report`. The report has no inferred HTTP RPS, WRS or DRS score; absent counters remain unknown. The HTTP path remains available separately.

An isolated fresh-memory instance on the lab VPS exercised the deployed companion source `eb0aa26249965f9cddd421870dbc991348cb6d6a`: `udp_dns_reflection`, six seconds, 120 configured input packets/s. The real loopback receiver measured 720 packets, 111.58 packets/s and 3,212,891.23 bits/s; the observed byte amplification ratio was 40×. Outcome: `UNMITIGATED_BASELINE` (no scrubber in this scenario). No public reflector or IoT agent was used. This is experimental synthetic evidence, not a mitigation success or DRS qualification.

The campaign followed request → runner claim → real bounded execution → completed verdict. The dedicated report was then regenerated from that exact retained record and visually checked, without emitting a second scenario. [Evidence receipt](qa/synthetic-replacement-2026-10-17/receipt.json), [report](qa/synthetic-replacement-2026-10-17/report.html). Fixture UI/API source mismatch is explicitly recorded; production acceptance remains subject to exact release gates and the saved browser-origin restriction. Production has a bench runner token configured and the lab runner service is active; these flags alone are not a live production campaign proof.

## ZeroBS throughput correction — 17 October 2026

The GET-Flood template now explicitly preserves its configured main target (`focusDynamic: false` survives custom-template validation). Recon no longer silently replaces this line with the costliest dynamic endpoint and fresh-connection pressure. Explicit dynamic-pressure templates retain their behavior. Existing stored campaigns and their endpoint sets are not rewritten: create a new GET campaign to use the corrected template.

The historical Vegeta adapter could allocate up to 20,000 workers despite the configured concurrency. That behavior is not restored. The current adapter preserves concurrency and rate/duration ceilings. On the Mac relay, the corrected GET measured 698.16 RPS with 100 workers and 510.92 RPS with 200; more workers did not remove that path's bottleneck.

A disposable lab-local fixture targeting the private Kubernetes service measured 771.75 RPS over its complete generator lifecycle, a 794.04-RPS live peak and 15,872 successful requests with no failures. A repeat with live Kubernetes log streaming measured 480.98 RPS; all 9,849 HTTP 200 target receipts were captured. The VPS has two CPUs and the k3d container a 1.5-CPU allocation. These observations do not establish a stable 800-RPS capacity guarantee or DRS qualification. The generated fixtures use fresh memory state, not production accounts or history.

Run Theater successful-response cards and final response-rate summaries now use the same generator observation window as offered throughput, excluding orchestration/baseline time from the response-rate divisor. Cancelled-run evidence parsing and failure-classification fixes from the preceding qualification are included. The separately archived results retain their original metrics and source/fixture limitations.

## Isolated ZeroBS / Vegeta qualification — 17 October 2026

A fresh loopback-only MemoryStore fixture, based on deployed build 468, exercised the GET-Flood template with explicit overrides: Vegeta, 800 requested RPS, 100 concurrent workers, 20 seconds. Production state and the three persistent Fleet Pods were untouched. Production browser acceptance remains blocked by its saved origin permission.

The initial Kubernetes port-forward relay disconnected under load. Its aborted execution exposed a Vegeta defect: the cancelled emission signal also cancelled offline result parsing, preventing a retained report. Source now gives that offline helper a separate 15-second deadline. A subprocess regression covers cancellation without emitting traffic.

With a temporary private TCP relay, the second execution completed and retained its report: 3,746 attempts, 167 successful, 178.43 effective RPS, 25% probe availability. The target archived 388 correlated receipts (169 HTTP 200, 169 HTTP 504, 50 HTTP 499). These are different observation points. Generator and probe shared the relay: this is inconclusive at 800 RPS and does not qualify DRS. The dynamic endpoint, fresh connections, concurrency cap and relay constrain delivery; no single cause of under-delivery is established.

Report source now separates 169 HTTP failures from 3,410 transport failures instead of counting distinct error strings or attributing failures to protection. Corrected HTML was regenerated from retained observations and visually checked. Corrections are not promoted to production. See [receipt](qa/zerobs-vegeta-800-2026-10-17/receipt.json) and [corrected report](qa/zerobs-vegeta-800-2026-10-17/report-corrected.html). Temporary qualification processes and relays were stopped.

This is a dated deployment observation, not a promise that an IP, Pod or release remains unchanged. Check `/health`, service identity and Kubernetes state before an operation. Private credentials and evidence live outside both repositories.

## Hosts and processes

| Host            | Actual role                                                                                               | Access and isolation                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `31.31.74.228`  | ShieldTester control plane, PostgreSQL, API/UI, independent HTTP observation for public Fleet diagnostics | API `127.0.0.1:8080`; Caddy HTTPS with client mTLS; service `ddostester`                  |
| `31.31.74.187`  | Linux HTTP Kubernetes lab and separate synthetic-bench runner                                             | K3s inside k3d Docker container `k3d-ddostester-linux-lab-server-0`; private lab services |
| Mac workstation | Source, development, kind laboratory manifests and private release/evidence archives                      | Local development and isolated tests; no current parity claim with Linux                  |
| `46.28.109.92`  | Dedicated authorized HTTP test target for earlier diagnostics                                             | Admission requires application allowlist, approved origins and worker/network policy      |

At the historical 15 October checkpoint, the production API/UI was Git build **466**, commit `8cec20c1ae59bb27135ec0e9fbfeb063a6985081`, at `/home/shieldtest/ddostester-releases/release-8cec20c.8C5Z1e/backend`, promoted at 18:58 UTC on 15 October. API/UI identities match and all four CI jobs plus native lint/typecheck/tests/build passed. The earlier archive build 463 used a different counter; compare full source identities. Health reports PostgreSQL, single mode, `single_admin`, DRS workflow enabled and built-in HTTP default. Protection-provider configuration is enabled; target telemetry and remote-probe flags are false. These flags do not establish independent DRS protection-entry evidence.

At promotion, all 11 accounts (sole administrator `abdelha@wedos`), 284 campaign records, settings and three Fleet identities were preserved; all three agents were online. Campaign history includes the earlier failed private acceptance and the retained offline simulation. Counts and older delivery sections below are dated checkpoints, not live counters.

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

## Classic main restoration branch — 17 October 2026

At the owner's request, `codex/main-classic-three-pods` starts from verified `origin/main` commit `58eff0b928d48d55b81f2bc57ab3037f616cd96f`. Application sources are unchanged from that reference: classic Command Center, Campaigns, Fleet, Run Theater and Results, with explicit single-owner campaign confirmation and persisted sole administrator `abdelha@wedos`. Existing three-agent Kubernetes configuration, identities, secrets and policies are retained; no cluster recreation or agent rollout is requested. The newer design and its evidence remain on `codex/passive-pop-readiness` (deployed code `d0ffa6aa6b0034a2efcba40693c152b088af56ae`, build 496). Preserve the current database and later schema/history rather than restoring an older production backup. Before promotion, validate this older application against an isolated copy of the current database, exact-source CI/native verification and a fresh encrypted restore. This entry records branch intent, not a completed deployment. Newer workspace/synthetic-manager features are intentionally absent from the classic interface; their stored records must not be deleted.

### Classic main delivery — 17 October 2026, 11:53 Paris time

Build 468, source `2067c984bfd885acda1f01927b61dcc1351b0be8`, is verified deployed from `codex/main-classic-three-pods`. Application sources match `origin/main` (`58eff0b`); the lower build number reflects that restored history, not a failed promotion. All four exact-source CI jobs and complete native VPS verification passed. The classic application initialized against an authenticated isolated restoration of the current database, retained all records/migrations and returned ready with single-owner authentication enforced. Production API/UI manifest identity, external mTLS health, unchanged policies/data/audit/infrastructure and three online agents passed. `lab-iot-01`, `lab-iot-02` and `lab-iot-03` remain Running with unchanged UIDs/IPs. Sole admin `abdelha@wedos`, 11 accounts, 284 campaigns, settings and three Fleet identities are preserved. Build 496 and its newer source branch remain available; no production campaign or Pod rollout occurred. The preview is local; production browser access remains blocked by its saved origin permission. See [delivery receipt](classic-main-deployment-checkpoint.json) and [classic interface preview](qa/classic-main-2026-10-17/campaigns.png).

## Historical ZeroBS catalogue profile — 17 October 2026

The previous classic-main restoration retained `CAMPAIGN_CATALOG=drs-fleet`, which still hid the historical template workflow. Branch `codex/zerobs-classic-three-pods` records the existing `legacy` catalogue profile in `deploy/profiles/classic-zerobs.env`. Application source remains unchanged from verified release 468 (`2067c984bfd885acda1f01927b61dcc1351b0be8`); this is a runtime profile correction, not another code downgrade. All 43 curated template IDs and complete step definitions match historical commit `d98db08` exactly. This includes `pretest-cra-l7` (P26-20371, 12 steps) and its 12 `cra-l7-*` individual templates. Their current display labels say DRS L7; the underlying definitions are the former ZeroBS templates. Local read-only browser verification reached the generator-choice dialog without creating or executing a campaign. Keep the persisted single administrator, explicit launch confirmation, target policies, unchanged caps and existing three Pods. The complete historical sequences keep their declared generators; the separate Fleet option is a bounded GET draft, not a replacement of all sequence semantics. See [historical identity proof](qa/zerobs-catalogue-2026-10-17/catalogue-comparison.json). Activation must be recorded separately from this source profile.

### ZeroBS catalogue activation — 17 October 2026, 12:13 Paris time

The historical catalogue profile is verified active in production: `CAMPAIGN_CATALOG=legacy`, `drsWorkflow=false`, `USER_MODE=single`, persisted `single_admin` policy. The existing build 468/code/assets remain unchanged, retaining their exact-source CI/native qualification; the activation changes only runtime catalogue selection. The versioned profile branch is published as `codex/zerobs-classic-three-pods`. A fresh encrypted backup and authenticated isolated restore passed before activation. Existing API/UI manifest identity, external mTLS health, readiness, protected routes, unchanged account/cap/target policies, all 284 campaigns, 11 accounts, custom playbook history, audit/infrastructure and settings passed. Three agents are online; the original three Pod UIDs/IPs are unchanged. No production campaign was created or executed. The public engine-availability endpoint reports the built-in, k6, Vegeta and Fleet providers available. Templates remain labelled DRS L7 after the earlier wording change; their IDs and steps match the former ZeroBS definitions exactly. Access them through Campaigns → Templates, searching P26-20371. The parent retains its 12-step sequence; Fleet is a separate bounded GET alternative. Production browser permission remains blocked; the read-only local UI preview verifies the same application/profile and the generator-choice dialog. See [activation receipt](zerobs-catalogue-deployment-checkpoint.json), [historical playbook preview](qa/zerobs-catalogue-2026-10-17/historical-playbook.png) and [identity comparison](qa/zerobs-catalogue-2026-10-17/catalogue-comparison.json).

### ZeroBS execution corrections — 17 October 2026 (local source)

The full original-duration qualification exposed four k6 output-budget failures,
four automatic safety stops and misleading missing-evidence presentation. Local
corrections suppress k6 progress/request logs without increasing process or traffic
caps, reject absent request metrics/nonzero engine exits, retain diagnostic references
in audit and suite reports, show failed steps explicitly, keep an observed suite
on stage after completion, and report missing load/availability as unmeasured.
Delivery ratios now compare mean achieved and mean expected rates, with peak
configuration identified separately. Approval messages reflect actual approved/skipped
counts. Existing local interface changes and historical qualification evidence are preserved.

These source changes are not a deployed release or a new successful 12-step
qualification. The HTTP-only lab target still cannot establish HTTP/2 coverage;
automatic safety stops remain active, and 800 req/s capacity is not established.
k6 flags follow the [official options reference](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/).

### Short ZeroBS replay — 17 October 2026

An isolated authenticated lab replay executed all 12 legacy L7 scenarios with
20-second configured load windows and no added interval. Existing baseline,
calibration, recovery and stop controls remained active. All 12 run records and
the consolidated report were retained; the sequence took 343.177 seconds including
those controls. Four k6 runs completed without the previous output-budget error.
The target recovered to HTTP 200 and the three persistent IoT Pods were preserved.
No production release was promoted. Phase rounding was corrected so wave/ramp
phases sum to the requested duration (20 seconds, rather than 21); 1,239 backend
tests, lint, type checking and compilation passed.

Graph review still found HTTP panels on the slow-connection scenario, an outage
banner not always supported by probe availability, zero-filled historical k6
load curves despite nonzero final summaries, missing persisted probe p95 samples,
and a breach glossary that incorrectly assumes an automatic kill. Four probe
samples per 20-second window are coarse; HTTP/2 coverage is not established on
this HTTP-only target. These findings are recorded, not claimed fixed by this replay.
See the [replay receipt](qa/zerobs-20s-2026-10-17/receipt.json) and
[retained report](qa/zerobs-20s-2026-10-17/report.html).

### Graph and report consistency audit — 17 October 2026 (candidate source)

The corrective source now retains explicit generator observation, successful counters,
probe sample counts, probe p95 and request/connection units in each timeline tick.
Live and historical app graphs share that contract. Unknown counters stay absent;
SlowLoris uses connection counts, and generator errors do not declare a global outage
or mitigation. Rates are cumulative means, not instantaneous peaks. Probe plots hold
observed values rather than smooth invented intermediate measurements, with observation
counts and cumulative semantics disclosed. Probe cadence and traffic caps are unchanged.

Both report types share evidence charts: historical k6 summaries cannot manufacture
a load timeline, missing latency remains unrecorded, and old records are not rewritten.
Derived assessments are refreshed at read time so cached historical interpretations do
not contradict current reports. HTTP/2-named runs without confirmed target support are
inconclusive. WRS remains a legacy diagnostic, distinct from a measured DRS score;
completion and safety-stop status are separate from the resilience verdict.

Grafana's live failure stat no longer falls back to an earlier run. Instant live stats,
non-smoothed sample steps, explicit absent values and neutral outcome labels preserve
the same meaning as the app. The source dashboard and Kubernetes copy remain aligned.
Deployed as build 483 (`d15afa3d8a09670e492634529029db7274e3d1cc`) after exact-source CI, native build/report checks and authenticated recovery. API/UI release identity, readiness, runtime configuration, all 289 campaigns, 11 accounts, the sole administrator and three Fleet identities were preserved. The private-lab replay completed all 12 steps at 20 seconds each with no added interval; final reports were regenerated from unchanged measurements. Both native and Kubernetes Grafana dashboards are loaded and the three persistent IoT Pods remain ready. Evidence: `docs/qa/graph-consistency-2026-10-17/`. Production browser access remained denied by its saved policy; the UI was verified in the isolated lab and production through authenticated health, asset and database checks.

### Three-pass critical report review — 17 October 2026 (source)

Three successive reviews cover numeric/graph accuracy, evidence-strength conclusions,
and coverage/traceability. Corrections include the real 0–100 WRS component scale,
unknown probe/risk values, current assessments in aggregates, descriptive comparisons,
complete-suite SLO requirements, connection CSV units, imported-lab uncertainty and
separate collection/render identities. Raw archived measurements and execution caps
are unchanged. See `docs/qa/reports-critical-2026-10-17/` for the three-pass record
and regenerated reports. This source review is separate from the deployed build 483;
any later release activation is recorded with its own delivery receipt.

Candidate build 485 (`0b5f403e396133f8e7763f9d7eae00fad8128d1c`) passed local checks and regenerated 227 historical individual reports and 50 suites on an isolated restored database. Production build 483 is retained while a new suite is running. Refresh the preservation snapshot and authenticated backup after that execution completes before any activation. No campaign was launched for this review.

Report corrections activated as build 485 (`0b5f403e396133f8e7763f9d7eae00fad8128d1c`) on 17 October 2026 at 20:54 UTC, after campaign completion and fresh authenticated backup recovery. All 301 campaigns, 11 accounts, sole administrator, settings, caps and three Fleet identities were preserved; HTTPS/API/UI identity and three ready IoT Pods were verified. Receipt: `docs/qa/reports-critical-2026-10-17/delivery.json`. This supersedes the earlier deferred activation status.

### Scenario fidelity and monitored-route availability — source correction

The classic negative-path step now preserves its specified paths instead of recon replacing them with a dynamic endpoint. Its expected missing resources are excluded from functional monitoring. Positive endpoint mixes include the selected probe and the resolved route URLs, bounded to eight monitored URLs in `config/limits.ts`. Every URL is allowlisted and revalidated before execution. Each URL is checked with a read-only GET; one aggregate probe cycle succeeds only when all checks succeed, using the existing timeout/cadence and automatic-stop thresholds. Individual counts appear in live tooltips, run details and reports. Per-route baselines are retained; primary-only baseline latency is not compared with a multi-route maximum.

Requested load remains the assessment denominator after downward calibration. A reduced exposure cannot pass the original requirement. Rapid Reset/Continuation are explicitly HTTP approximations; the classic THOR wave and carpet-bombing labels disclose one generator/one host. These approximations cannot establish the named protocol/distributed resilience. Historical evidence remains unchanged, while current projections flag missing route coverage and unsupported conclusions.

This corrects measurement and interpretation; it does not raise traffic limits, add amplification, improve flood throughput, implement protocol abuse or establish DRS 5. GET route checks do not verify authenticated or POST transactions. A broader journey requires explicit assertions and independently received-load evidence. Local regression coverage includes a healthy root with a failed application route, automatic stop, per-route baselines, live progress and final report. No external campaign is needed for this verification. Activation must have its own delivery receipt.

Scenario-fidelity candidate build 488 (`7a0ed66ee0820c05a5b703ed6c7c588a5bfdb09b`) passed 1,270 backend and 471 frontend tests, 287 native Linux checks and exact-source CI 39069978751. The restored-copy check regenerated 239 individual reports, 51 suites and the portfolio without mutation. Activation was refused before restart at 21:19 UTC because the campaign count rose to 305 with one running campaign and changed account records. Production remains build 485. Refresh the backup/preservation snapshot after that execution before activation; do not reuse the earlier 301-campaign snapshot. Evidence: `docs/qa/scenario-fidelity-2026-10-17/validation.json`.

### Protected zones workspace — source implementation

The default screen now shows authorized hosts from the current target registry and configured allowlist; the filter exposes all registered records for management. It supports authorization filtering, host/name search, live campaign links, template-based configuration and capability-governed target metadata/authorization management in collapsed details. Configured access is identified separately because revoking a registry entry does not remove an independent environment allowlist entry. No health check or traffic is started by this screen, and authorization is not presented as service availability.

Retained campaign-derived hosts are loaded only when Historical activity is opened. That section has search, pagination, recorded dates and an exact-host link to the campaign history including archives. Historical WRS, inferred edge absorption and name-derived DRS levels no longer appear as current assurance. Campaign history now honors the explicit `host` and `archived=1` deep links; the host filter is visible and clearable. Existing authorization rules and raw history are preserved. Isolated frontend workflow tests and local visual fixtures cover these changes; this is not a production activation receipt.

### Interface consistency source changes — 18 October 2026

Local source compacts page/card spacing, mobile navigation and the assistant header; fixes form, template and button alignment; and improves shared dialog/help behavior. The Theater uses three chart columns when space permits and preserves fractional HTTP failure percentages. The eleven routed views were checked in Chrome at desktop/mobile widths with isolated demonstration data, plus confirmation/help and authentication layouts. Frontend regression passes 480 tests. These changes are not deployed. See [visual review evidence and limits](qa/interface-consistency-2026-10-18/README.md).
