# Control plane and isolated laboratory boundary

ShieldTester governs authorized bounded HTTP tests and evidence. It contains a capped HTTP generator and bounded slow-header resilience probe; external adapters delegate to installed load tools. It does not implement network amplification, source spoofing or unbounded exhaustion. Safeguards in [AGENTS.md](../AGENTS.md), `backend/src/config/limits.ts` and the target/approval/kill/audit policy remain mandatory.

The [companion lab](https://github.com/abdelhasoloji/shieldtest-lab) contains a confined synthetic UDP/TCP measurement model. Its JSON traffic-shape profiles are not real public reflector protocols. Compose uses an internal network; the address guard accepts private/loopback IPv4 and optionally narrows it to a lab prefix. The default Compose prefix is `192.168.100.`. Do not describe the standalone base guard as an unconditional fixed-/24 rule: it first validates RFC1918/loopback.

The existing governed bench runner claims an approved named scenario and posts a verdict/metrics artifact. This is a laboratory dispatch and artifact-ingestion contract; it does not give the control plane an arbitrary network generator. Protection and target telemetry providers may pull exposed summaries. A bench artifact is diagnostic evidence, not an automatic DRS vector PASS. See [cross-repository contract](cross-repo-contract.md).

The synthetic bench is distinct from the Kubernetes HTTP Fleet, even when both use the lab VPS. Fleet uses normal HTTP against explicitly approved origins. Private Pod IPs behind one public egress cannot establish distributed Internet-source diversity.

The lab also contains experimental L3 dry-run/namespace simulation modules. Their real packet backend remains disabled. They do not add spoofing capabilities to ShieldTester or establish measured DRS coverage.

Reports separate simulation, experimental laboratory results and measured evaluations. No virtual-source or byte-factor multiplier may inflate actual received traffic. See [measurement](measurement.md) and [qualification gaps](roadmap.md).
