# Verification

## Local gates

```sh
npm run lint
npm run typecheck
npm run test -w backend -- --maxWorkers=2
npm run test -w frontend -- --maxWorkers=2
npm run build
```

Workspace configs default to two workers to limit contention without loosening test timeouts. The tracked pre-push hook runs lint/typecheck/tests. CI additionally enforces workspace coverage thresholds from the Vitest configurations, dependency audit, PostgreSQL and recovery gates. Use those configuration files as authority rather than copied threshold tables.

## Meaningful contracts

Backend tests cover target/origin admission, budgets, identity/capability policy, transactional audit, evidence integrity, scoring terminal rules, retries/history, simulation isolation, Fleet stop/progress and registry pagination. Frontend tests cover the assessment workspace, modes, explicit selection, unknown live telemetry and compact counts. DRS fixtures validate the software contract, not physical protection capacity.

PostgreSQL tests require `DATABASE_URL_TEST` pointing to a disposable isolated database. CI uses `REQUIRE_POSTGRES_TESTS=1` so missing setup fails instead of silently skipping. `npm run test:postgres -w backend` and recovery recipes must never target production. Keep database credentials out of shell transcripts and Git.

Browser tests use local identified fixtures and their intended config. Render Kubernetes/Compose manifests before applying anything; a render does not prove CNI enforcement or live stop semantics. Native tool recipes are documented separately under `scripts/conformance/`.

## Last product checkpoint

Build 463 was verified with local backend/frontend suites, PostgreSQL and encrypted restore, native VPS candidate gates, local visual assessment/report/mobile checks and API/UI identity checks. It included one software-only campaign with reproducible simulation score 1, no physical campaign traffic. [Current setup](current-setup.md) describes that deployed checkpoint. New source changes require fresh gates and are not implicitly deployed.

Remaining physical qualification includes entry/origin collectors, functional journeys, Kusa and scaled infrastructure execution. See [roadmap](roadmap.md).
