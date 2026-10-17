# ARM64 image qualification

This first product increment validates packaging in a local Linux ARM64 Docker VM. It does not qualify HPE hardware, network throughput, production authentication, or DRS capacity.

## Repeatable local check

Use Node 22 and a Linux ARM64 Docker engine. From a clean, committed checkout:

```sh
source_commit=$(git rev-parse HEAD)
docker build --platform linux/arm64 -f backend/Dockerfile --build-arg SHIELDTEST_COMMIT="$source_commit" --build-arg SHIELDTEST_BUILD=arm64-lot1 -t shieldtester-arm64:lot1 .
node --test scripts/operations/arm64-image-smoke.test.mjs
node scripts/operations/arm64-image-smoke.mjs shieldtester-arm64:lot1 "$source_commit" /tmp/arm64-qualification.json
```

The bounded smoke check uses an isolated team-mode, in-memory fixture with no network or published ports. It checks process architecture, readiness, source identity, served UI asset hashes and imports of the Fleet worker and adapter. It starts no campaigns and removes its container. It does not exercise Fleet assignments or production single-admin storage.

## Manual CI

The `ARM64 qualification` workflow is manual only, uses `ubuntu-24.04-arm`, runs the full verification suite with a disposable PostgreSQL service, builds the image and uploads the smoke receipt. It does not publish images or deploy. Its name differs from `CI`, so it does not match the production deployment workflow's `CI` trigger.

[GitHub documents ARM64 runners for private repositories](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/). Workflow availability and execution remain to be checked after an explicit publication step; local execution is not evidence of a completed GitHub run.

## Handoff

Keep the receipt's exact source commit and image digest. The local result is limited to this fixture. NICs, public addresses, VPN routing, two-server qualification and measured sizing remain separate roadmap lots. Existing traffic limits and automatic stops remain in place.
