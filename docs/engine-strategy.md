# Generator adapters and selection

`backend/src/agents/index.ts` is the runtime adapter registry. It retains builtin, k6, Vegeta, Locust, JMeter and Gatling integrations plus Fleet paths; availability/capabilities depend on installed tools and runtime configuration. Old usage counts are not today's installation status.

The built-in HTTP engine has its own sustainable ceilings and supports the implemented bounded request/flow paths. External tools are selected through explicit capabilities and validated configuration; selecting Fleet must not silently fall back to a local generator. Persistent Fleet currently supports bounded GET laboratory missions, not every external-engine or IoT business-message feature.

Gatling supports the explicitly configured offline Maven bundle through `GATLING_HOME`; the legacy launcher path remains separate. Native recipes in [conformance](../scripts/conformance/README.md) distinguish fixture support from installed-tool qualification. Do not infer an engine's exact version or conformance from its name.

General HTTP hard ceilings and Fleet's smaller shared execution envelope are in `backend/src/config/limits.ts`. None demonstrate maximum attainable throughput. See [Fleet missions](fleet-missions.md), [measurement](measurement.md) and [roadmap](roadmap.md).
