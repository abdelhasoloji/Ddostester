# Boundary, load engines & the isolated lab

Why the control plane implements **no attack vector**, how load is actually
generated (the pluggable engines), the **class A/B/C** policy that decides what
may be governed and where it runs, and the **read-only, governed contract** with
the separate `shieldtest-lab` bench.

For the safeguards themselves see [security-and-governance.md](./security-and-governance.md).

---

## 1. The two boundaries (both must hold)

1. **Control plane** (`backend/` + `frontend/` — the deployed product) implements
   **no attack vector**. Its only load vector is a bounded, allowlisted, capped,
   audited HTTP generator (`backend/src/engine/loadTest.ts`).
2. **Closed synthetic lab** — a **measurement model, not an amplifier** — lives
   in a **separate repository**,
   [`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab),
   so the boundary is **structural**: this repo contains no amplification/spoofing/UDP
   code at all.

### What is NOT implemented (control plane), by design

- **L3/L4 volumetric**: UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS
  flood, DNS/NTP/SSDP/CLDAP reflection/amplification, Smurf.
- **L7 exhaustion as abuse**: RUDY, cache-bypass, brute-force, WebSocket flood,
  GraphQL abuse, XML bomb, "browser botnet".
- Any generation at an unbounded rate or toward a target outside the allowlist.

These **saturate** a service rather than **measure** its resilience. Adding any
of them to the control plane is out of scope and must not be merged (`CLAUDE.md`,
`SECURITY.md`).

---

## 2. Load generation — the pluggable engines

The control plane **governs and measures**; it **delegates** load emission to an
**agent** implementing the `AttackAgent` contract (`backend/src/agents/types.ts`).
No offensive code lives in this repo — every non-builtin engine shells out to a
tool installed and operated by the team.

Selection is two-tiered (`backend/src/agents/index.ts`,
`AGENT=builtin|k6|vegeta|locust` sets the server default; each campaign may
override via its `agent` field). `GET /api/agents` reports every engine with live
availability + capabilities; Settings lists them installed/not.

| Agent          | Tool       | Rate-capped                     | Multi-phase | Flow | Parsed output       |
| -------------- | ---------- | ------------------------------- | ----------- | ---- | ------------------- |
| `builtin-http` | in-process | yes (sliding window)            | yes         | yes  | internal            |
| `k6`           | k6         | yes (arrival-rate)              | yes         | yes  | `--summary-export`  |
| `vegeta`       | Vegeta     | yes (`-rate`)                   | yes         | no   | `report -type=json` |
| `locust`       | Locust     | approximate (`constant_pacing`) | no          | no   | `--csv`             |

Capability flags per engine are in each adapter (`backend/src/agents/*.ts`,
fields `multiPhase`/`flowCapable`/`correlationCapable`). Creation validates
against them (an unknown engine, or a multi-phase scenario on a constant-only
engine, is rejected); an absent binary fails execution with a clear **503**.
Each adapter applies `validateConfig` (allowlist + caps) and honours the kill
switch, so it inherits every safeguard.

**High-rate auto-routing** (measurement fidelity): the built-in engine saturates
~150 rps, so a high-rate _simple_ flood is auto-upgraded to an available
out-of-process engine (`backend/src/modules/campaigns/engine-route.ts`,
`BUILTIN_RPS_CEILING` in `backend/src/config/limits.ts`). Conservative — only
shapes the target engine provably handles; correlation flows / endpoint-mix /
dataset / assertion stay on the built-in engine.

Deliberately **not** scaffolded: **wrk / hey** (built for max throughput, no
simple rate cap — contrary to the bounded model). JMeter/Gatling are JVM-heavy;
prefer k6/vegeta. L3/L4 volumetric generators (TRex/MoonGen/pktgen) are the
network team's, never provided here.

> **Governance prerequisites before any campaign** (independent of the tool):
> written internal authorization + signed scope (Security Officer, dated window);
> isolated environment (never third-party/production); upstream coordination;
> declared blast radius (dedicated IPs, `X-WEDOS-TEST` tagging, rollback plan).

---

## 3. Capability classes — the policy that decides where a technique runs

Every red-team technique is classified; the class decides whether ShieldTest may
govern it and where it executes. This extends, never overrides, §1 — where this
policy and a "never" disagree, the "never" wins.

| Class                               | Techniques (examples)                                                                       | Governed by ShieldTest?                                          | Executes on                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| **A — Correctness probes**          | request smuggling CL.0/TE.CL; SQLi vs **our** WAF; cache-poison header tests; JA4 inventory | **Yes** — closest to the bounded-HTTP probe model                | Isolated lab runner, lab target                     |
| **B — Boundable exhaustion**        | HTTP/2 Rapid Reset (CVE-2023-44487), MadeYouReset (CVE-2025-8671), H2 "bomb"                | **Yes, with hard per-technique caps** + kill switch + auto-abort | Isolated lab runner, lab target **only**            |
| **C — Volumetric / spoofing L3-L4** | any amplification, SYN flood, carpet bombing, DNS water torture                             | **No — permanently excluded from the platform**                  | Network team's isolated bench (TRex/MoonGen/pktgen) |

Class **C** is a deliberate, **code-enforced refusal** — admitting it would be
the definition of _un_bounded. **All current L3/L4 trends (2024–2025)** —
hyper-volumetric floods, carpet bombing, UDP/DNS/NTP/CLDAP/memcached
amplification-reflection, DNS water torture, SYN/ACK/RST floods, fragmentation /
mixed multi-vector — are class C: documented for a complete DRS matrix (see
[measurement.md](./measurement.md) §Scenario catalogue) and routed to the bench,
never run here.

### Non-negotiable invariants for validation work

- Deployed product implements no attack vector; no source-IP spoofing anywhere.
- `HARD_CAPS` + allowlist never weakened for a test; dual control stays.
- Every action on the audit chain; every request carries `X-WEDOS-TEST`.
- Nothing runs on a shared/anycast edge node.

### Target isolation (hard separation)

- `LAB_TARGETS` lists only isolated lab hosts the team fully owns, with **no route
  to production**. A DRS-validation campaign may target **only** `LAB_TARGETS`; a
  normal campaign **only** `ALLOWED_TARGETS`. **Any overlap is rejected at
  startup**, any cross-set target at creation (`backend/src/app.ts:139-145`;
  fail-closed).

### Roles for validation

CISO owns the safety envelope (sets operational limits, governance only);
Security Officer authorizes each campaign; Engineer authors (no self-approve);
the Runner operator maintains the isolated runner (the only party that executes
class A/B, only from a signed job vs `LAB_TARGETS`); the Network team owns all
class C on their own bench.

---

## 4. The isolated lab & its governed contract

The lab reproduces the **traffic shape and measurement problem** of UDP
amplification for defensive study — no source-IP spoofing, no real
DNS/NTP/SSDP/memcached service, hard caps on every factor, an `internal: true`
Docker network with no egress. It used to live under `lab/`; it now lives in
`abdelhasoloji/shieldtest-lab` (full design + safety proofs in that repo's docs).

The two repos connect **only** through a read-only, governed contract — never a
live attack path. This describes the **control-plane side**; the mirror is
`shieldtest-lab/docs/cross-repo-contract.md`.

### Channel 1 — Governed dispatch (record-and-dispatch)

The CISO records a request; the lab runner claims it and posts back a verdict.
The control plane emits **no** traffic.

| Step    | Control-plane side                                                                       | Lab side                     |
| ------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| Request | `POST /api/bench/runs` (`bench:dispatch`) → `REQUESTED` (`backend/src/app.ts:1010-1045`) | —                            |
| Claim   | `POST /api/bench/runs/next/claim` (Bearer `BENCH_RUNNER_TOKEN`) (`app.ts:1047-1054`)     | `runner.mjs:22-27`           |
| Run     | —                                                                                        | `run-scenario.mjs` (bounded) |
| Verdict | `POST /api/bench/runs/:id/result` (`app.ts:1056-1118`)                                   | `runner.mjs:34-38`           |

- Runner auth = dedicated token, constant-time compare, never a user JWT
  (`app.ts:987-994`); verdict accepted only for a `CLAIMED` run else `409`
  (`app.ts:1063-1068`); the job carries only an allowlisted scenario name, never
  a host/rate/duration (`runner.mjs:9-11`).
- `LAB_TARGETS` never overlaps `ALLOWED_TARGETS` (`app.ts:139-145,975-984`).

### Channel 2 — Measurement connectors (pull, read-only)

The control plane **reads** lab metrics to enrich a run's WRS.

| Measure              | Lab endpoint                                                                  | Control-plane connector                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Detection/mitigation | scrubber `GET /protection` (`shieldtest-lab .../scrubber/server.mjs:249-253`) | `PROTECTION_METRICS_URL` → `PollProtectionProvider` (`backend/src/modules/protection/provider.ts:139-162`)                 |
| Host load            | target `GET /telemetry` (`shieldtest-lab .../target/receiver.mjs:82-86`)      | `TARGET_TELEMETRY_METRICS_URL` → `PollTargetTelemetryProvider` (`backend/src/modules/target-telemetry/provider.ts:91-110`) |

The control plane also exposes an adapter `GET /api/protection/lab-metrics`
(`app.ts:1138-1165`) that republishes the scrubber's last measure in the pull
shape; it requires the `x-wedos-shieldtest: protection-query` marker and returns
`404` with no measure (never a fabricated zero).

### Contract safety properties

- **Read-only**: the control plane only pulls or receives a posted verdict; it
  opens no amplification socket.
- **Fail-closed**: dispatch is off without `LAB_TARGETS` **and**
  `BENCH_RUNNER_TOKEN` (`app.ts:1011-1015`); the runner is off without
  `BENCH_API_URL` + `BENCH_RUNNER_TOKEN` (`shieldtest-lab/runner.mjs:75-78`).
- **Class C never posted as A/B**: a bench verdict is standalone evidence
  recorded `MEASURED_LAB` (`app.ts:1085-1108`), never a `drs.verdict`.

### Coverage methods (honest, labelled)

Recorded read-only via `POST /api/bench/coverage` (`bench:attest`, CISO, audited
`bench.coverage`): `MEASURED_LAB` (a real bounded lab run — the only emitting
method, synthetic/loopback), `INGESTED_EXTERNAL` (a verdict from the network
team's real bench), `ATTESTED` (a control check, e.g. BCP38/uRPF — verification,
not emission), `MODELLED` (estimated judgement, no traffic), `REPLAY` (sanitized
PCAP in the isolated lab, spoofed sources rewritten). None emit spoofed or
raw-flood traffic. Attestation checklists (`/api/bench/attestations`) and
external import (`/api/bench/coverage/import`) give auditable, deterministic
outcomes.

The bench catalogue mirrors the **Volumetric** section of a DRS report
(reference **P25-20300**): five reproducible vectors (UDP amplification/rate +
two no-spoof TCP state-table vectors) and six **out-of-model** ones that can
never be dispatched (`ip_spoofing`, fragmentation, GRE, multi-proto combos).

Class-A/B validation verdicts are recorded separately via
`POST /api/drs-validations` (officer, `campaign:approve`) into the audit chain
(`drs.verdict`) — it records, never executes, and rejects class C / non-lab /
cross-set / bad outcomes fail-closed.
