# ShieldTester

ShieldTester is the resilience-testing application in this private `Ddostester` repository. It prepares governed campaigns, orchestrates simulated IoT clients, collects evidence and produces versioned DRS reports. The companion [shieldtest-lab](https://github.com/abdelhasoloji/shieldtest-lab) is an isolated synthetic network bench.

## Current product

| Mode                 | Purpose                                                               | Meaning of the result                                                             |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Engine validation    | Virtual events; no target traffic                                     | Simulation score only                                                             |
| Synthetic laboratory | Bounded traffic in an authorized laboratory                           | Experimental evidence, with represented and missing dimensions                    |
| Measured evaluation  | Independent generator, protection-entry, user and origin measurements | DRS interpretation-profile result; missing evidence stays partial or inconclusive |

The immutable DRS 3.00.00 catalogue contains 131 vector rows. Seven GET rows expose bounded laboratory approximations; the other rows are reference/simulation only. Full-standard physical adapters are not enabled. Measured dispatch awaits qualified instrumentation and capacity.

The registry supports 5,000 devices across 100 sites. Current physical Fleet execution is limited to **3 agents, 15 requests/s shared, concurrency 6 and 10–60 seconds**. Registry capacity is not concurrent traffic capacity. Three persistent agents are provisioned on the Linux VPS; their distinct private IPs share one public egress IP.

Production last observed on 14 October 2026: **build 463**, PostgreSQL, single-user workflow, sole administrator `abdelha@wedos`. Kusa and the infrastructure multisite cluster remain pending. See [verified setup](docs/current-setup.md).

## Development

Use the Node version in `.nvmrc` (minimum 22.19), npm workspaces and PostgreSQL for the default single workflow.

```sh
npm ci
cp .env.example .env
# Configure protected authentication, database and a local authorized allowlist.
npm run build
# On initial installation, preview and explicitly apply the account migration:
node backend/dist/cli/migrate-users.js
node backend/dist/cli/migrate-users.js --apply
npm run dev:api
# In another terminal:
npm run dev:web
```

Follow [account setup](docs/single-user.md) before starting single mode. Secrets, CA keys and client bundles stay outside Git. Fixtures can use team-mode memory storage; that is not the production setup.

```sh
npm run lint
npm run typecheck
npm run test -w backend -- --maxWorkers=2
npm run test -w frontend -- --maxWorkers=2
npm run build
```

Start with **Campaigns → DRS assessment → New engine validation · no traffic** to test the product without dispatching agents. Explicit approval and target attestation remain required for physical campaigns.

## Documentation

[Documentation index](docs/README.md) · [DRS engine](docs/drs-engine.md) · [Architecture](docs/architecture.md) · [Fleet](docs/fleet-management.md) · [Operations](docs/operations.md) · [Remaining work](docs/roadmap.md) · [Contributor rules](AGENTS.md).
