# API process

`backend/src/server.ts` configures runtime store, authentication, adapters, scheduler and graceful shutdown. `buildApp()` in `app.ts` composes Fastify routes and injectable dependencies for tests. Domain route modules now live under `backend/src/routes/`; old monolithic line-number inventories are obsolete.

Current production is loopback 8080 behind Caddy HTTPS/mTLS, PostgreSQL and single-admin mode. `/health` exposes runtime/build/configuration identity, `/ready` gates readiness. Neither is a completed campaign or DRS physical qualification.

Targets, account capabilities, authorization, shared budgets, timing and stop policy are enforced server-side. DRS plan/evidence mutations are transactional and reject stale revisions, archived records and conflicts with physical running campaigns. Error references are public; raw internal errors stay in server logs.

See [API contracts](../api.md), [access](../single-user.md), [operations](../operations.md) and [current setup](../current-setup.md).
