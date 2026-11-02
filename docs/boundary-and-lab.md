# Control plane and isolated laboratory boundary

ShieldTester governs **authorized** resilience tests and the evidence they produce. The
invariant is the authorization model — signed target, window, caps, kill switch, audit — not
the transport. Today's engine is a capped HTTP generator plus a bounded slow-header probe;
external adapters delegate to installed load tools. The target is a measured DRS 5
evaluation, and reaching it requires a packet-level engine under the same safeguards, not
around them: see [DRS 5 capability target](drs5-target.md).

Network amplification, source spoofing and unbounded exhaustion remain out of scope at every
stage. Safeguards in [AGENTS.md](../AGENTS.md), `backend/src/config/limits.ts` and the
target/approval/kill/audit policy remain mandatory.

## Where each thing actually lives

Resolve ambiguity here rather than from a filename:

| Concept                                                      | File                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Synthetic HTTP generator (the "amplifier")                   | `backend/src/engine/loadTest.ts`                                                  |
| Slow-header probe, and the only raw TCP connect              | `backend/src/engine/slowloris.ts`                                                 |
| External tool adapters (vegeta, k6, locust, jmeter, gatling) | `backend/src/agents/`                                                             |
| Every rate/concurrency/duration ceiling                      | `backend/src/config/limits.ts` (`HARD_CAPS`, `BUILTIN_*_CEILING`, `FLEET_LIMITS`) |
| High-rate routing above the built-in ceiling                 | `backend/src/modules/campaigns/engine-route.ts`                                   |
| DRS assessment state machine (no sockets)                    | `backend/src/modules/drs/orchestrator.ts`                                         |
| DRS draft/freeze/evidence/finalize transitions               | `backend/src/modules/drs/workflow.ts`                                             |

No module defines its own copy of a cap: they import from `config/limits.ts`. A change to a ceiling is a reviewed security change, not a tuning parameter.

The [companion lab](https://github.com/abdelhasoloji/shieldtest-lab) contains a confined synthetic UDP/TCP measurement model. Its JSON traffic-shape profiles are not real public reflector protocols. Compose uses an internal network; the address guard accepts private/loopback IPv4 and optionally narrows it to a lab prefix. The default Compose prefix is `192.168.100.`. Do not describe the standalone base guard as an unconditional fixed-/24 rule: it first validates RFC1918/loopback.

The existing governed bench runner claims an approved named scenario and posts a verdict/metrics artifact. This is a laboratory dispatch and artifact-ingestion contract; it does not give the control plane an arbitrary network generator. Protection and target telemetry providers may pull exposed summaries. A bench artifact is diagnostic evidence, not an automatic DRS vector PASS. See [cross-repository contract](cross-repo-contract.md).

The synthetic bench is distinct from the Kubernetes HTTP Fleet, even when both use the lab VPS. Fleet uses normal HTTP against explicitly approved origins. Private Pod IPs behind one public egress cannot establish distributed Internet-source diversity.

The lab also contains experimental L3 dry-run/namespace simulation modules. Their real packet backend remains disabled. They do not add spoofing capabilities to ShieldTester or establish measured DRS coverage.

Reports separate simulation, experimental laboratory results and measured evaluations. No virtual-source or byte-factor multiplier may inflate actual received traffic. See [measurement](measurement.md) and [qualification gaps](roadmap.md).
