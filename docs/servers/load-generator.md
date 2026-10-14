# Generator and Fleet execution

`backend/src/agents/index.ts` registers local/installed-tool adapters. `engine/loadTest.ts` handles bounded HTTP; `engine/slowloris.ts` is a bounded slow-header resilience probe. Hard deadlines and kill handling prevent indefinite runs. The built-in sustainable ceilings differ from the general immutable HTTP envelope; consult `config/limits.ts` and runtime health.

Persistent Fleet GET missions select exact enrolled workers and divide a shared budget. Current execution caps are three agents, 15 requests/s, concurrency six and 10–60 seconds. The older Kubernetes Job adapter is a separate path, disabled on production. A disabled catalogue vector cannot silently fall back to another engine.

The official catalogue is a reference, not a declaration of adapter support. Seven GET rows have bounded laboratory approximations; other rows are reference/simulation only. Full-standard physical adapters and measured dispatch await qualified capacity/instrumentation.

HTTP targets may be private or public when explicitly authorized and admitted. No amplification/raw spoofing emitter exists in this control plane. See [engine strategy](../engine-strategy.md), [mission contract](../fleet-missions.md) and [boundary](../boundary-and-lab.md).
