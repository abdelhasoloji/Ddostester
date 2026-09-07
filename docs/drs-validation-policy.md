# DRS validation policy — governing the red-team PoC kit, ethically and bounded

How WEDOS's internal DRS (DDoS / Resilience Shield) red-team proof-of-concepts
— reset floods, protocol smuggling, injection, cache poisoning, TLS/JA4
enumeration, L3/L4 volumetric — may be brought under ShieldTest's **governance
and measurement** without turning the control plane into an attack platform.

This document extends, and never overrides, the boundary already stated in
[`ethical-boundary-map.md`](./ethical-boundary-map.md),
[`offensive-integration.md`](./offensive-integration.md),
[`safeguards.md`](./safeguards.md) and [`network-lab.md`](./network-lab.md).
Where this policy and a "never" in those documents disagree, the "never" wins.

## 1. The one rule

**Govern the workflow, not the weapon.** ShieldTest authorizes, bounds,
schedules, records and scores a validation test. It **never emits** a
protocol-abuse or flood vector from its own process, and **never** from a shared
or production host. Offensive execution is delegated to a dedicated, isolated
**lab runner** operated by the team — exactly the delegation model already used
for load agents (`AttackAgent`), extended to the validation class.

This keeps the control plane's invariant intact: _its only in-process load
vector remains the bounded, allowlisted, capped, audited HTTP generator._

## 2. Non-negotiable invariants (unchanged)

- The deployed product (`backend/` + `frontend/`) implements **no attack vector**.
- No source-IP spoofing, ever, anywhere in the platform.
- `HARD_CAPS` (2000 rps / 500 concurrency / 900 s) and the allowlist are never
  weakened to accommodate a test.
- Dual control stays: author ≠ approver **and** approver ≠ executor.
- Every action is on the tamper-evident audit hash chain; every emitted request
  carries `X-WEDOS-TEST`.
- Nothing in this policy runs on **ac02 / 10.20.2.1** or any shared Cilium/K8s
  edge node — those carry public/anycast IPs and other tenants.

## 3. Capability classes — the safety boundary

Every technique in the kit is classified. The class decides _whether_ it can be
governed by ShieldTest and _where_ it executes.

| Class                                                                                                             | Techniques (from the kit)                                                                                                | Governed by ShieldTest?                                                                                       | Executes on                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **A — Correctness probes** (single / low-volume; tests whether a defense _classifies/blocks_ a malformed request) | request smuggling `CL.0`, `TE.CL`; SQLi against **our own** WAF; cache-poisoning header tests; JA4 fingerprint inventory | **Yes** — closest to the existing bounded-HTTP probe model                                                    | Isolated lab runner, lab target                                                                                                   |
| **B — Boundable exhaustion** (finite, capped, auto-abortable)                                                     | HTTP/2 rapid reset (CVE-2023-44487), MadeYouReset (CVE-2025-8671), HTTP/2 "bomb"                                         | **Yes, with hard per-technique caps** (max streams/pps, duration, concurrency = 1) + kill switch + auto-abort | Isolated lab runner, lab target **only**                                                                                          |
| **C — Volumetric / spoofing L3-L4** (not boundable in a control-plane sense)                                      | `syn-flood.py`, `volumetric-test.sh`, any amplification                                                                  | **No — permanently excluded from the platform**                                                               | Network team's isolated bench, manual change-control (TRex/MoonGen/pktgen or contracted provider), per `offensive-integration.md` |

Class **C** is a deliberate, code-enforced refusal. Admitting it would be the
definition of *un*bounded. That refusal is what makes the rest defensible.

> **Current L3/L4 trends (2024–2025) are all class C.** The latest reported
> volumetric TTPs — hyper-volumetric multi-Tbps/Gpps floods, **carpet bombing**
> (spread across a subnet/CIDR), UDP/DNS/NTP/CLDAP/memcached
> **amplification-reflection**, **DNS water torture** (random-subdomain floods),
> SYN/ACK/RST and TCP connection floods, and fragmentation / mixed multi-vector
> (GRE/UDP/TCP) — are packet-level and/or spoofable by nature. None has a
> bounded control-plane analogue, so **none is replicated in the app**: they are
> documented for a complete DRS matrix (see
> [`assessment-methodology.md`](./assessment-methodology.md) §4) and routed to
> the network team's isolated bench (§7 deny-list, §11). "Replicate the latest
> L3/L4 attacks in the app" resolves to "document them as class C", by design.

## 4. Target isolation — the hard separation rule

Validation tests never share a target namespace with production measurement.

- A new allowlist, **`LAB_TARGETS`**, lists only isolated lab hosts/CIDRs that
  the team fully owns and that have **no route to production**.
- **Enforced invariant:** a DRS-validation campaign may target **only**
  `LAB_TARGETS`; a normal bounded-HTTP campaign may target **only**
  `ALLOWED_TARGETS`. Any overlap between the two sets is rejected at startup, and
  any cross-set target is rejected at campaign creation (fail closed).
- The kit's scripts hard-code real domains (`404m.com`, `w8.cz`, `wedos.com`,
  `185.8.239.0`). Those must be **stripped and replaced by a lab target injected
  per job** before any script is admitted to the runner. A script that resolves
  or connects to anything outside `LAB_TARGETS` is refused by the runner.

## 5. Governance workflow (reuses existing primitives)

A validation campaign carries the same governance as any campaign, plus a few
class-specific gates:

1. **Written authorization + dated scope** (Security Officer), per campaign —
   the attestation shape already in `campaigns/model.ts`, extended with the
   technique id and the lab target.
2. **Dual approval + separation of duties** (unchanged).
3. **Scheduling window + upstream coordination** for class B (notify network/ops
   before any exhaustion test, even in lab).
4. **Blast-radius declaration**: runner id, lab target, per-technique caps,
   max duration, expected collateral = none.
5. **Audit**: create / approve / dispatch / verdict all appended to the hash
   chain; the signed job id ties the runner's actions back to the campaign.

## 6. Blast-radius & execution controls

- **Concurrency = 1** for class B; one validation runs at a time.
- **Per-technique hard caps** enforced by the runner _and_ re-checked server-side
  (max streams, max pps, absolute duration), independent of the script's own args.
- **Kill switch (3-level)** and an **auto-abort** on any collateral signal
  (target unavailable to the legitimate probe, runner egress outside lab).
- **Egress-filtered runner**: a dedicated VM / network namespace whose only
  reachable destinations are `LAB_TARGETS`; default-deny everywhere else.
- **Time-boxed**; the runner self-terminates the job at the cap.

## 7. Permanent deny-list (fail closed, in code)

The following are rejected before dispatch, with no override flag:

- Any class **C** technique (volumetric L3/4, amplification).
- Source-address spoofing of any kind.
- A target not in `LAB_TARGETS`, or a target that also appears in
  `ALLOWED_TARGETS`.
- Dispatch to a runner that is not the declared isolated runner, or from a host
  that is not the runner (the control plane never opens raw/H2-abuse sockets).

## 8. Architecture — the governed lab runner

ShieldTest **does not execute** the PoC. It emits a **signed job** to the runner
and ingests a **verdict**. The control plane opens no raw or protocol-abuse
socket; it dispatches and records.

```
Officer ──approve──▶ ShieldTest (control plane)
                        │  signed job {technique, labTarget, caps, window, jobId}
                        ▼
             Isolated lab runner (VM/netns, egress = LAB_TARGETS only)
                        │  runs the *vetted* PoC, bounded by caps + auto-abort
                        ▼
             Lab target (instrumented; DRS mitigation under test)
                        │  verdict {mitigationHeld, metrics, evidence}
                        ▼
             ShieldTest  ──▶ audit + compliance view (read-only)
```

### Signed job (control plane → runner)

```jsonc
{
  "jobId": "uuid",
  "campaignId": "uuid",
  "technique": "h2-rapid-reset", // from the class A/B catalogue only
  "class": "B",
  "labTarget": "https://<lab-host>/", // must be in LAB_TARGETS
  "caps": { "maxStreams": 200, "maxPps": 50, "maxDurationSec": 30, "concurrency": 1 },
  "window": { "notBefore": "…", "notAfter": "…" },
  "authorizedBy": "officer@wedos",
  "sig": "…", // signed; the runner verifies before running
}
```

### Verdict (runner → control plane)

```jsonc
{
  "jobId": "uuid",
  "outcome": "MITIGATED | NOT_MITIGATED | INCONCLUSIVE | ABORTED",
  "technique": "h2-rapid-reset",
  "metrics": { "…": 0 }, // technique-specific, non-actionable summary
  "collateral": "none", // auto-abort if not none
  "evidenceRef": "lab-artifact://…", // logs/pcap kept in the lab, referenced only
  "ranAt": "…",
  "runner": "runner-01",
}
```

The verdict is **read-only** in ShieldTest — it feeds the compliance view and a
per-technique pass/fail history, mirroring how WRS regressions are tracked. The
attack traffic never traverses the control plane.

### Implemented so far

- **`LAB_TARGETS`** env (comma-separated). At startup `buildApp` **fails closed**
  if any lab target also appears in `ALLOWED_TARGETS` (§4). Surfaced in `/health`
  and **Settings → Lab targets (DRS)**.
- **`POST /api/drs-validations`** (officer-only, `campaign:approve`) records a
  verdict `{ technique, class (A|B), labTarget, outcome, detectionSec?,
mitigationSec?, runner? }` into the **tamper-evident audit chain**
  (`drs.verdict`). It rejects **class C**, a non-`LAB_TARGETS` host, a host that
  is also in `ALLOWED_TARGETS`, and a bad outcome — all fail-closed. It records;
  it never executes the technique.

- **Governed class-C network-bench dispatch** (the record-and-dispatch loop for
  the UDP-amplification bench). The control plane records a **CISO-authorized**
  run request and serves it to an **isolated external runner** (the
  `shieldtest-lab` repo); it never emits amplification traffic. Endpoints:
  - `GET /api/bench/scenarios`, `GET /api/bench/runs[/:id]` (`bench:read`, CISO):
    the allowlisted scenario catalogue and the run/verdict history.
  - `POST /api/bench/runs` (`bench:dispatch`, CISO): records a run request for an
    allowlisted scenario against a `LAB_TARGETS` host (fail-closed isolation, as
    §4), audited `bench.request`. Disabled unless a `LAB_TARGETS` host **and** a
    `BENCH_RUNNER_TOKEN` are configured.
  - Runner API (bearer `BENCH_RUNNER_TOKEN`, never a user JWT):
    `POST /api/bench/runs/next/claim` atomically claims the oldest request;
    `POST /api/bench/runs/:id/result` posts back a **read-only class-C verdict**
    (validated: `class === 'C'`, matching scenario), audited `bench.verdict`.
    The verdict is class C — it is **not** a class-A/B `drs.verdict` and is never
    recorded through `/api/drs-validations`; it is read-only evidence surfaced in
    **Settings → Network bench (CISO)**. The runner is the only component that
    emits the (bounded, loopback) amplification traffic.

  - The bench catalogue mirrors the **Volumetric** section of a zeroBS DRS
    stress-test (reference report **P25-20300**), so the CISO sees a 1:1 mapping
    with the report: each vector carries its DRS level and whether the bench can
    reproduce it. Only the UDP amplification/rate vectors (`udp_dns_reflection`,
    `udp_maxpackets`, `udp_multivector`) are reproducible; the TCP/GRE stateful
    floods, `ip_spoofing` and fragmentation vectors are shown for coverage but are
    **out of model** and can never be dispatched (spoofing is never permitted
    here by construction). The report's Layer-7 vectors are bounded-HTTP and live
    in the control-plane playbooks (`assessment-methodology.md`), not this bench.

Remaining: the per-technique pass/fail history surfaced in the assessment report.

## 9. Defensive matrix (the practical companion)

The real "before / after DRS" deliverable: what each PoC validates and how to
confirm the mitigation is on _and_ held. Metrics are summary-level only — this
table drives verification, not exploitation.

| PoC (kit)                              | Technique / CVE                       | Class          | Mitigation it validates                                    | Pass =                                                   |
| -------------------------------------- | ------------------------------------- | -------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `rapidreset.py`                        | HTTP/2 Rapid Reset · CVE-2023-44487   | B              | H2 stream-reset rate limiting / concurrent-stream governor | availability held, no upstream saturation                |
| `madeyoureset.py`                      | MadeYouReset · CVE-2025-8671          | B              | H2 abnormal-reset accounting                               | server closes/GOAWAYs abusive conn; probe stays up       |
| `http2-bomb.py`                        | H2 HPACK / buffer exhaustion          | B              | HPACK table & buffer caps at the edge                      | bounded memory/pools; connection capped                  |
| `cl0_smuggling_te_cl_conflict.py`      | Request smuggling TE.CL               | A              | frontend/backend header normalization                      | smuggled request not honoured (400/normalized)           |
| `cl0_smuggling_request_prefix_body.py` | Request smuggling CL.0                | A              | same                                                       | same                                                     |
| `cache-poisoning.py`                   | Web cache poisoning (unkeyed headers) | A              | cache key hygiene / header stripping                       | poisoned response not served to others                   |
| `sqli.py`, `curl-sqli.py`              | SQL injection                         | A              | WAF ruleset (against **our** app)                          | payloads blocked / not reflected in results              |
| `ja4-enumeration/*`                    | JA4 client fingerprint inventory      | A              | fingerprint-based classification / bot mgmt                | inventory recorded; classification behaves as configured |
| `syn-flood.py`                         | TCP SYN flood (L3/4, spoofable)       | **C**          | SYN cookies / scrubbing                                    | **not run via platform** — network-team bench only       |
| `volumetric-test.sh`                   | L3/4 volumetric (playbook)            | **C**          | edge scrubbing / anycast absorption                        | **not run via platform** — network-team bench only       |
| `l7.sh` + `*.lua`                      | wrk-based L7 load                     | (bounded HTTP) | rate limiting / WAF                                        | already covered by the bounded `AttackAgent` model       |

## 10. Rollout — in order, smallest blast radius first

1. **This policy** (done) — classification, `LAB_TARGETS` rule, caps, deny-list.
2. **Defensive matrix** filled with each mitigation's owner + current on/off state.
3. **Runner contract**: implement job signing + verdict ingestion as **read-only**
   in the compliance view (no execution in the control plane).
4. **Class A first** (correctness probes — safest, most immediately useful for WAF
   validation), against `LAB_TARGETS`, in the isolated runner.
5. **Class B** in the isolated lab, one technique at a time, with ops notified.
6. **Class C never** enters the platform.

## 11. Roles & responsibilities

- **CISO** — owns the safety envelope: the only role that sets the operational
  limits (the effective caps, always ≤ the immutable `HARD_CAPS` ceiling), from
  the UI, audited. Governance only — not an operator.
- **Security Officer** — authorizes each campaign, owns scope and window.
- **Engineer** — authors the validation campaign; does not self-approve.
- **Runner operator** — maintains the isolated runner; the only party that can
  execute class A/B, and only from a signed job against `LAB_TARGETS`.
- **Network team** — owns all class C testing on their own bench, outside this
  platform.
- Authorization attestation remains **declarative** (a barrier, not proof); scope
  responsibility stays with the operator, as in `security-review.md`.
