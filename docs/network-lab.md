# Synthetic network lab — moved to its own repository

The closed synthetic UDP-amplification **measurement** lab that used to live in
this repository under `lab/` now lives in a **separate repository**:

> **https://github.com/abdelhasoloji/shieldtest-lab**

## Why it was split out

The lab reproduces the **traffic shape and measurement problem** of UDP
amplification for defensive study (filtering, telemetry, detection delay,
availability). It is a **measurement model, not an amplifier** — no source-IP
spoofing, no real DNS/NTP/SSDP/memcached service, no public reflector, hard caps
on every factor, and an `internal: true` Docker network with no egress.

Even so, it is offensive-**shaped** code, and this repository is a **defensive
control plane that must contain no attack vector at all**. Keeping the two in one
repo made that boundary a convention. Extracting the lab makes it **structural**:

- the control plane here only ever performs **bounded, allowlisted HTTP**, and
  contains no amplification/spoofing/UDP code whatsoever;
- the amplification-shaped bench lives, runs, is governed and is CI-tested
  entirely on its own, never near production.

The full lab design and safety rationale (topology, hard caps, no-spoofing
proof, profiles, mitigation node, Prometheus metrics, scenarios, invariant
tests) now live in that repository's `README.md` and `docs/network-lab.md`.

## How the two still connect (read-only, governed)

They connect **only through a read-only, governed contract** — never a live
attack path. The bench produces a **verdict / metrics summary** (amplification
factor, detection delay, mitigation efficacy, collateral) that ShieldTest
**ingests read-only** for its resilience assessment, exactly as described in
[`drs-validation-policy.md`](./drs-validation-policy.md). ShieldTest never opens
a raw or amplification socket; the lab never touches the production network.
