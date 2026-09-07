# Resilience assessment methodology & report format

Inspired by the zeroBS **DDoS Resiliency Score (DRS)** stress-test methodology and
report format, adapted to ShieldTest's **bounded** model. We keep the structure,
the scoring discipline and the scenario taxonomy; we drop everything that is not
a bounded, allowlisted, capped HTTP measurement.

> **Bounded adaptation.** A zeroBS engagement fires real volumetric floods
> (UDP/TCP/ICMP up to tens of Gb/s), source spoofing, and IoT-botnet L7 floods.
> ShieldTest implements **none** of that. We reproduce the **L7 traffic _shape_**
> within `HARD_CAPS`, measure the target's behaviour, and score it. Volumetric,
> amplification and spoofing stay out of the platform — see
> [`drs-validation-policy.md`](./drs-validation-policy.md) (classes A/B/C) and
> [`offensive-integration.md`](./offensive-integration.md).

## 1. Methodology (DRS, applied within our limits)

The DRS discipline we adopt, per zeroBS DRS v23:

1. **Threat modelling** — pick the attacker capability/TTP to approximate, not a
   raw volume. What matters is the _shape_ (endpoint spread, fingerprint
   rotation, method mix, cache pressure), which we can reproduce bounded.
2. **Measurable criteria** — detection, mitigation, availability, recovery time.
   ShieldTest measures these via the legitimate probe, the baseline delta, status
   codes and the WRS.
3. **Customisation** — the target set is customer-defined (our own allowlist),
   not OSINT. Per DRS, a customer-defined-target engagement is **capped at DRS
   4.5** even if a level-5 shape is exercised and absorbed. We carry that cap.
4. **Testing procedure** — run scenarios in sequence, one per DRS level; **each
   scenario gets a pass/fail and a level**. A single passing level-N scenario
   does **not** pass the level (levels are complementary, not cumulative).
5. **Assessment & improvement** — the report drives remediation; regressions are
   tracked per target (already in ShieldTest via WRS history).

## 2. Report format (adapted from zeroBS)

The aggregate **Resilience Assessment** report follows the zeroBS layout:

| zeroBS section                                    | ShieldTest equivalent                                     |
| ------------------------------------------------- | --------------------------------------------------------- |
| Cover (report id, scope, tester, confidentiality) | Header (period, generated-at, "WEDOS internal")           |
| Management Summary → Scope                        | Scope: period, targets, engines, bounded-HTTP statement   |
| Technical Setup                                   | Protection posture (inferred) + engines used              |
| Results (summary table + narrative)               | Summary + **per-scenario results table**                  |
| Protection Level (Volumetric / L7 radar)          | L7 only; volumetric marked **out of scope**               |
| DRS explanation                                   | WRS ↔ DRS mapping (§3)                                    |
| Worst-case / Business impact                      | Worst runs (WRS < 70) + impact note                       |
| Technical risk (radar)                            | Findings by category (config/scaling/workflow) — optional |
| Details: Volumetric / L7 summary tables           | Per-run detail: peak RPS, WRS, mitigation, RiskLevel      |
| Per-attack detail (schedule, TTD/TTM, mitigation) | Per-run notes (kill reason, availability, baseline Δ)     |
| Glossary (RiskLevel, TTD/TTM, PPS/RPS…)           | Glossary (§3)                                             |

The per-run detail already exists (campaign report, now with the kill
explanation). This methodology adds the **assessment-level** shape to the
aggregate compliance report.

## 3. Scoring & vocabulary (zeroBS ↔ ShieldTest)

| Term                       | zeroBS meaning                                | ShieldTest mapping                                          |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| **DRS level**              | Attacker capability level 1–7 of the scenario | Scenario tag (documentation); target-defined ⇒ **cap 4.5**  |
| **Score**                  | DRS pass/fail per scenario                    | **WRS 0–100** + pass/fail vs acceptance SLO                 |
| **RiskLevel**              | Low / Medium / Critical (impact × time)       | Derived from status + probe availability + WRS (§3.1)       |
| **Mitigation**             | instant / fully / partially / none            | Derived from status + availability (§3.2)                   |
| **TTD** (Time-To-Detect)   | until the attack is detected                  | Time to auto-kill trip, when a protection source reports it |
| **TTM** (Time-To-Mitigate) | until fully mitigated                         | Recovery time in the run timeline, when observable          |
| **RPS**                    | requests/second (L7)                          | `generator.actualRps` (capped ≤ 2000)                       |
| **PPS / volumetric**       | packets/second (L3-4)                         | **n/a — out of scope**                                      |
| **RampUp / Plateau**       | attack launch curve / saturation              | `ramp` / `wave` load profiles; plateau = capacity knee      |

### 3.1 RiskLevel (bounded definitions)

Mirrors zeroBS's Low/Medium/Critical, scored on what we actually measure:

- **Low** — run COMPLETED, probe availability ≈ 100 %, WRS ≥ 80. The target
  served the bounded load with no meaningful degradation.
- **Medium** — COMPLETED but availability dipped or WRS 55–79, or recovery took
  time (partial degradation under a lawful, bounded rate).
- **Critical** — the target went unavailable (auto-kill) or WRS < 55: it could
  not sustain a bounded, authorized load — a real capacity/resilience finding.

### 3.2 Mitigation / availability verdict

- **Held (instant/full)** — COMPLETED, availability ≈ 100 %.
- **Partial** — COMPLETED, availability degraded (some legitimate traffic lost).
- **Failed (impact)** — auto-killed: the legitimate probe found the target
  unavailable ≥ 30 s (the run's `statusDetail` explains it).
- **Aborted** — manually stopped by an operator.

> Honesty caveat (same as WRS): without a protection integration, ShieldTest
> attributes the outcome to **measured availability**, not to a specific
> mitigation device. Detection/mitigation timings are estimates unless a
> protection source reports them — the report flags this.

## 4. Scenario catalogue (the retained ones)

Every zeroBS scenario mapped to its bounded ShieldTest realization, or marked
out of scope. "Playbook" = a curated one-click sequence (`docs/usage.md`).

### Layer 7 — reproduced, bounded

| zeroBS L7 scenario                                  | Bounded ShieldTest realization                          | Mitigation signal measured                   | Where                                        |
| --------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `get_flood`                                         | Steady GET load (readiness / burst playbooks)           | availability, rate-limit onset, status codes | now                                          |
| `random_flood` (invalid URLs → 404 / URL-allowlist) | Mixed **non-existent** paths, bounded                   | 404 / edge URL-allowlist enforcement         | now (endpoint mix)                           |
| `random_valid_flood`                                | Mixed **valid** paths, bounded (cache-key stress)       | cache-hit ratio, origin shielding            | now (playbook)                               |
| `post_flood` / PUT (method policy → 405)            | Bounded POST/PUT load                                   | 405 / method-allowlist enforcement           | needs `vector` on playbook steps             |
| `http_multivector`                                  | Endpoint mix + UA rotation (signature-evasion playbook) | WAF/rate-limit vs mixed shape                | now (playbook)                               |
| `get_flood (IoT v2)`                                | UA rotation, bounded (signature-evasion)                | fingerprint-based classification             | now (playbook)                               |
| `http2_multiplexing_get_flood`                      | Bounded high-rate over h2 (http2-burst playbook)        | h2 request-path resilience                   | now (bounded) / abuse = lab class B          |
| `slowloris`                                         | Slow, connection-holding shape                          | slow-request mitigation                      | bounded partial; abuse = lab class B         |
| `waf_cracker` (WAF bypass)                          | Single malformed-request correctness probe              | WAF ruleset classification                   | lab **class A** (`drs-validation-policy.md`) |
| `tcp_handshakes` (conn flood)                       | — (L4 connection flood)                                 | —                                            | out of scope (L3/4)                          |
| `upstream-jamming`, `session_exhaustion`            | — (exhaustion)                                          | —                                            | lab class B, capped, or not reproduced       |

### Volumetric — out of scope (documented, not run here)

`udp_dns_reflection`, `tcp_synflood`, `udp/tcp_maxpackets`, `ip_spoofing`,
`udp/tcp_fragmentation`, `multi/gre multivector` → **class C** in
`drs-validation-policy.md`: never in the platform; network team's isolated bench
(TRex/MoonGen/pktgen) or a contracted provider. The report lists them as
**"volumetric — out of scope"** so a reader sees the full DRS matrix and where
each part is validated.

## 5. What "closest, still bounded" means in practice

- We reproduce the attacker's **shape and intent** (endpoint spread, fingerprint
  rotation, method/URL policy pressure, cache pressure, h2 request path) — never
  the harmful **mechanism** (flood volume, spoofing, stream-cancel abuse,
  cache-buster bypass). Each threat-informed playbook already records this in its
  `notReproduced` field.
- The **report** reads like a zeroBS assessment (scope, per-scenario table,
  RiskLevel, mitigation verdict, glossary) so it's directly comparable — while
  every number comes from a bounded, allowlisted, audited run.

## 6. Next steps

1. Reshape the aggregate compliance report into this assessment format
   (per-scenario results table, RiskLevel, mitigation verdict, glossary). ← in progress
2. Add the two missing bounded playbooks: `random_flood` (404/URL-allowlist) and
   `post_flood` (needs a `vector` field on `PlaybookStep`).
3. Tag each playbook with its DRS level + zeroBS scenario reference.
