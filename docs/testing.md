# Testing

The test suite is a pyramid: a wide base of fast unit/property tests, a middle
of API-integration and store-contract tests, and a thin browser E2E on top —
plus a cross-cutting safeguards suite that makes the security boundary
executable.

## Layers

| Layer           | Where                                              | What it covers                                                                     |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit (pure)     | `backend/test/*`, `frontend/src/*.test.ts`         | scoring, parsing, validation, form helpers                                         |
| Property-based  | `backend/test/invariants.test.ts`                  | WRS ∈ [0,100] & level, rate/picker invariants (fast-check)                         |
| **Safeguards**  | `backend/test/safeguards.test.ts`                  | no input bypasses caps / allowlist / authorization / separation of duties (fuzzed) |
| API integration | `backend/test/integration.test.ts`, `rbac.test.ts` | Fastify routes, RBAC matrix, concurrency guard                                     |
| Store contract  | `backend/test/store-contract.test.ts`              | memory **and** postgres behave identically                                         |
| Component       | `frontend/src/ui-components.test.tsx`              | badges, RunDetails, CampaignCard RBAC gating (Testing Library)                     |
| E2E (browser)   | `e2e/critical-path.spec.ts`                        | the built SPA serves, login works, reaches the API (Playwright)                    |

## Running

```bash
npm test                 # all unit/integration (fast) — part of `npm run verify`
npm run test:coverage    # same, with v8 coverage + enforced thresholds (what CI runs)
npm run test:e2e         # builds, then the Playwright browser smoke (separate CI job)
```

### Postgres store contract

Skipped unless a disposable database is provided:

```bash
DATABASE_URL_TEST=postgresql://user:pass@127.0.0.1:5432/shieldtest_test npm test -w backend
```

It runs the real migrations and SQL against that database.

## Coverage thresholds

Enforced per workspace in `vitest.config.ts` (CI fails below the floor):

- **backend**: lines/statements 73, branches 79, functions 84 (external-tool
  `run()` paths are integration-only; the floor rises as unit coverage grows).
- **frontend**: lines/statements 55, functions 30, branches 50 (page + form +
  component tests; rising as more of the UI gets covered).

## Deliberately not adopted

- **Mutation testing (Stryker)**: high run cost for marginal added signal once
  property + safeguards tests are in place. Revisit if a regression slips past
  the current suite.
