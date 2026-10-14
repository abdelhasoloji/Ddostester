# Contributor instructions — ShieldTester

Read [documentation](docs/README.md), [current setup](docs/current-setup.md) and [roadmap](docs/roadmap.md) before changing behavior. Preserve local work and distinguish source implementation, deployed release and independently qualified measurements.

## Product and execution

This repository is the Fastify/TypeScript, PostgreSQL and React/Vite control plane. Its DRS engine freezes reference/profile versions, plans and evidence. Persistent Fleet missions currently operate three bounded HTTP workers. The companion shieldtest-lab produces confined synthetic network evidence.

Authorized public or private HTTP targets are supported when the application allowlist, approved origins, worker policy and campaign authorization all agree. There is no blanket ban on public HTTP test targets. The control plane has no amplification or source-spoofing emitter. The separate synthetic bench retains its network guard, registered scenarios, budgets and isolated execution; do not introduce arbitrary public amplification.

All execution and storage bounds belong in `backend/src/config/limits.ts`. Operational limits are admin-managed and clamped to immutable ceilings. Preserve approval/explicit single-owner confirmation, kill/stop behavior, evidence provenance and audit. Registry capacity does not authorize matching traffic capacity. Do not silently substitute generators, agents, sources or missing evidence.

## Development and verification

Use Node from `.nvmrc` (minimum 22.19), strict TypeScript ESM imports ending in `.js`, English code comments and npm workspaces. Default single workflow needs PostgreSQL and the explicit account migration described in [single-user.md](docs/single-user.md); fixtures may use legacy team-mode memory storage.

```sh
npm ci
npm run lint
npm run typecheck
npm run test -w backend -- --maxWorkers=2
npm run test -w frontend -- --maxWorkers=2
npm run build
```

Use disposable databases for PostgreSQL tests, never the production database. Browser tests use local isolated fixtures. The pinned standard directory is immutable: source or interpretation changes need a new version/profile, not a silent edit.

## Accounts, secrets and delivery

`abdelha@wedos` is the sole admin; other accounts remain managed profiles. Do not create a second admin or overwrite passwords/status during startup. The administrator has full application capabilities; frontend reads the server capability contract.

Secrets and PKI stay outside Git (current workstation PKI: `~/shieldtest-pki`). Never print tokens, private keys or protected runtime environment values. Use [operations](docs/operations.md) for immutable release promotion and rollback; check API/UI source identity. Keep [roadmap](docs/roadmap.md) and current behavior documentation in sync. Do not infer Kusa integration or physical DRS qualification from fixtures or provider configuration flags.
