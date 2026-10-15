# Verification

## Local gates

```sh
npm run lint
npm run typecheck
npm run test -w backend -- --maxWorkers=2
npm run test -w frontend -- --maxWorkers=2
npm run build
```

Workspace configs default to two workers to limit contention without loosening test timeouts. The tracked pre-push hook runs lint/typecheck/tests. CI additionally enforces workspace coverage thresholds from the Vitest configurations, dependency audit, PostgreSQL and recovery gates. The backend coverage job now has its own disposable PostgreSQL service and runs serially, so database-backed contracts contribute to the same coverage report. The separate PostgreSQL/recovery job remains required. Use those configuration files as authority rather than copied threshold tables.

## Meaningful contracts

Backend tests cover target/origin admission, budgets, identity/capability policy, transactional audit, evidence integrity, scoring terminal rules, retries/history, simulation isolation, Fleet stop/progress and registry pagination. Frontend tests cover the assessment workspace, modes, explicit selection, unknown live telemetry and compact counts. DRS fixtures validate the software contract, not physical protection capacity.

PostgreSQL tests require `DATABASE_URL_TEST` pointing to a disposable isolated database. CI uses `REQUIRE_POSTGRES_TESTS=1` so missing setup fails instead of silently skipping. `npm run test:postgres -w backend` and recovery recipes must never target production. Keep database credentials out of shell transcripts and Git.

Browser tests use local identified fixtures and their intended config. Render Kubernetes/Compose manifests before applying anything; a render does not prove CNI enforcement or live stop semantics. Native tool recipes are documented separately under `scripts/conformance/`.

## Last product checkpoint

Build 463 was verified with local backend/frontend suites, PostgreSQL and encrypted restore, native VPS candidate gates, local visual assessment/report/mobile checks and API/UI identity checks. It included one software-only campaign with reproducible simulation score 1, no physical campaign traffic. [Current setup](current-setup.md) describes that deployed checkpoint. New source changes require fresh gates and are not implicitly deployed.

Remaining physical qualification includes entry/origin collectors, functional journeys, Kusa and scaled infrastructure execution. See [roadmap](roadmap.md).

## Reliability increment — 15 October 2026

The previous main CI passed its assertions but failed backend function/branch and frontend statement/line coverage thresholds, so deployment was skipped. The repair retains those thresholds and adds behavioral coverage rather than excluding runtime code.

New contracts exercise inventory create/edit/removal failures, read-only access, site paging and retained exact agent selection, explicit enrollment rotation/revocation, stale DRS revisions, evidence import errors and reproducible exports. Assistant tests cover explicit single-admin confirmation, stop after ambiguous launch response, power-operation failures and bounded attachments. All external operations in these tests are inert fixtures or loopback-only services.

Target telemetry must mark counter resets, missing counter samples or target changes incomplete while preserving raw maxima. The standalone heartbeat client's monotonic schedule rechecks both its next emission and lifetime after a timer wake, preventing an extra near-deadline heartbeat. Existing isolated real-client restart tests exercise this behavior.

Local verification and GitHub CI are separate receipts; inspect the run for the exact pushed commit before claiming deployment. Collector endpoints, Kusa and physical infrastructure capacity remain external qualification dependencies.

The deployment bootstrap regression test (`node --test scripts/operations/deploy-bootstrap.test.mjs`) uses a temporary local Git origin and an older clone. It proves the workflow executes the exact CI commit script and refuses dirty source without altering HEAD or local files. No service is restarted in this test.

Local verification receipt for this increment: 1,222 backend tests passed with PostgreSQL (four explicit conditional skips), 455 frontend tests passed; backend coverage 83.96% statements / 79.13% branches / 85.88% functions / 85.88% lines, frontend 80.33% statements / 71.54% branches / 74.62% functions / 82.31% lines. Lint, typecheck, build and the isolated deployment-bootstrap test passed. These local results do not substitute for the remote commit-specific CI or production identity check.

## Native template preparation regression

Installed engines made the VPS gate expose duplicate tool discovery during legacy suite preparation: the same request probed every engine before preparing the suite and again before reconnaissance. Local/CI hosts without those binaries masked the delay. Instantiation and composition now share one discovery result with recon, and validate both destinations before probing tools. Regression tests assert one discovery, recon fallback and pending approval; unauthorized targets, probes, protocols and embedded credentials perform neither discovery nor recon. Test timeouts and execution ceilings are unchanged.

The first operator promotion of the reliability increment stopped at this native test gate, before changing the service. Automatic deployment also exposed an existing permissions mismatch: the runner cannot create immutable release directories. Keep the runner's limited sudo policy; an operator promotion still requires the exact green CI commit, the complete native gate, backup and preservation/identity checks.

The final deployed code's [CI receipt](https://github.com/abdelhasoloji/Ddostester/actions/runs/38666811959) records 1,232 passing backend tests with PostgreSQL (four conditional skips), 455 passing frontend tests and successful recovery. Backend coverage: statements 83.96%, branches 79.19%, functions 85.89%. The native VPS gate independently passed 1,200 backend tests (36 conditional skips), 455 frontend tests and the complete lint/typecheck/build sequence. Production readiness, API/UI identity and preservation checks passed; all three agents were online afterward. These checks launched no physical campaign.
