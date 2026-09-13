# Measurement — WRS, assessment methodology & the replay loop

How ShieldTest turns a bounded run into a resilience score (WRS), the
zeroBS-DRS-inspired assessment report it produces, the five-phase engagement
model the UI is organised around, and the tune-and-replay loop that closes a
weakness. All of it is **inbound measurement** — it generates no attack traffic.

---

## 1. WRS — WEDOS Resiliency Score

A 0–100 score computed **from measured metrics** by a pure function
(`backend/src/modules/wrs/scoring.ts`) that generates no traffic.

```
WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C
```

| Comp. | Name              | Computation                                   | Bounded |
| ----- | ----------------- | --------------------------------------------- | ------- |
| D     | Detection         | `100 − detection_s / 2`                       | [0,100] |
| M     | Mitigation        | `100 − mitigation_s / 3`                      | [0,100] |
| A     | Availability      | `legitimate_success / legitimate_total × 100` | [0,100] |
| C     | Collateral damage | `100 − adjacent_service_impact`               | [0,100] |

| WRS    | Level | Interpretation        |
| ------ | ----- | --------------------- |
| 95–100 | A+    | exceptional           |
| 85–94  | A     | excellent             |
| 70–84  | B     | acceptable            |
| 50–69  | C     | identified weaknesses |
| 30–49  | D     | insufficient          |
| 0–29   | F     | not resilient         |

**Origin of the inputs.** A and C come from the **probe** (availability on the
target + neighbouring endpoints). D and M: with no protection integration the
runner derives conservative estimates from the kill-switch state and flags the
score `estimated`.

**Automatic baseline.** Before the ramp, each run captures a short
legitimate-traffic-only baseline (nominal availability + latency,
`backend/src/modules/campaigns/baseline.ts`); the run detail and report then show
**under-load deltas** (Δ p95, Δ availability) so a result is interpretable on its
own.

**Measured D & M (protection integration).** Wire one of two connectors (same
JSON shape; webhook wins if both set) to replace estimates with real timings:

- **Push** — `PROTECTION_WEBHOOK_URL`: at run end the plane POSTs the run window.
- **Pull** — `PROTECTION_METRICS_URL`: the plane GETs metrics with the run window
  as query params.

The source answers `{ detectionTimeSec, mitigationTimeSec, source }`. `source`
labels provenance (else `PROTECTION_SOURCE_LABEL`; a lab `mock` is always tagged
`mock`). On any error/timeout/invalid payload it silently falls back to the
estimate. `/health` reports `protection: true|false`; the run then carries
`protection: { source, detectionTimeSec, mitigationTimeSec }` (TTD/TTM), surfaced
as a **Protection (measured)** panel/section and a `TTD…·TTM…` prefix in the
aggregate assessment.

---

## 2. Assessment methodology (bounded DRS)

Inspired by the zeroBS **DDoS Resiliency Score (DRS)** stress-test methodology
and report, adapted to ShieldTest's **bounded** model: keep the structure,
scoring discipline and scenario taxonomy; drop everything that isn't a bounded,
allowlisted, capped HTTP measurement (volumetric/amplification/spoofing stay out
— see [boundary-and-lab.md](./boundary-and-lab.md)).

DRS discipline applied within our limits: (1) threat-model the attacker **shape**,
not raw volume; (2) measurable criteria — detection, mitigation, availability,
recovery — via the probe, baseline delta, status codes and WRS; (3)
customer-defined targets ⇒ **capped at DRS 4.5**; (4) run scenarios in sequence,
**each gets a pass/fail + level** (levels are complementary, not cumulative);
(5) the report drives remediation, regressions tracked per target (WRS history).

### RiskLevel & mitigation verdict (bounded definitions)

- **RiskLevel** — Low: COMPLETED, availability ≈ 100 %, WRS ≥ 80. Medium:
  availability dipped or WRS 55–79. Critical: went unavailable (auto-kill) or
  WRS < 55 — a real capacity finding.
- **Mitigation** — Held (COMPLETED, ≈ 100 %) / Partial (availability degraded) /
  Failed (auto-killed ≥ 30 s unavailable) / Aborted (operator stop).

> **Honesty caveat.** Without a protection integration, the outcome is attributed
> to **measured availability**, not a specific device; D/M are estimates unless a
> source reports them — the report flags this.

### Reports (designed documents, not table dumps)

Both the per-run and aggregate reports render as **self-contained HTML/SVG** (no
JS, no external libs, CSP-clean, prints to PDF): a branded cover with a
confidentiality mark, an auto-generated management summary, an _At a glance_
scorecard (WRS gauge + RiskLevel/Mitigation pills + KPI cards), and inline-SVG
charts — traffic and availability timelines on **separate** axes (never a dual
axis), WRS-component and latency bars, score-by-grade and risk distributions, a
WRS trend. Helpers: `backend/src/modules/reports/charts.ts`; chrome:
`reports/layout.ts`; builders: `reports/{report,compliance}.ts`.

**Before/after comparison** — the core zeroBS deliverable ("did protection
improve?"): `GET /api/reports/compare?a=<runId>&b=<runId>` and the Reports-page
card render two runs side by side with signed deltas (WRS, availability, probe
p95, mitigation verdict, RiskLevel, TTD/TTM) and an Improved/Regressed headline
(`reports/compare.ts`).

### Scenario catalogue (L7 reproduced, bounded)

Each zeroBS L7 scenario maps to a bounded ShieldTest playbook that keeps the
**shape** and drops the **mechanism** (recorded per playbook in its
`notReproduced` field). Examples: `get_flood`→steady GET; `random_flood`→invalid
paths (404 / URL-allowlist, `threat-url-allowlist`); `post_flood`→bounded POST
(405 / method policy, `threat-method-policy`); `http_multivector`→endpoint mix +
UA rotation; HTTP/2 CONTINUATION (`threat-http2-continuation`); MadeYouReset
CVE-2025-8671 (`threat-madeyoureset`); Aisuru/Mirai-class L7
(`threat-aisuru-botnet`); JA4 enumeration (`threat-ivan-ja4-*`). Each
threat-informed playbook carries a `drsLevel` (3–5) badge. **Volumetric L3/L4 is
class C** — documented in the report under "Volumetric / L3-L4 — class C, network
bench", never emitted (see [boundary-and-lab.md](./boundary-and-lab.md)).

Scoring vocabulary (zeroBS ↔ ShieldTest): DRS level → scenario tag (target-defined
⇒ cap 4.5); Score → WRS + pass/fail vs SLO; RPS → `generator.actualRps` (≤ 2000);
PPS/volumetric → n/a (out of scope).

---

## 3. The five-phase engagement model

ShieldTest is organised around the five phases of an offensive engagement,
**adapted to a defensive, bounded model** — the lifecycle's spine, never its
weapons. The UI's **phase rail** threads the pages in this order.

| #   | Offensive phase        | ShieldTest (bounded)                                             | UI page                    |
| --- | ---------------------- | ---------------------------------------------------------------- | -------------------------- |
| 1   | Reconnaissance         | Passive + published-surface recon (posture, surface, baseline)   | **Preparation** `/prepare` |
| 2   | Scanning / enumeration | Gap analyzer: defenses → DRS ladder, weakest link, break point   | **Plan** `/plan`           |
| 3   | Exploitation           | **Bounded load delivery** — governed, capped playbook/suite runs | **Campaigns** `/campaigns` |
| 4   | Maintaining access     | **Impact & resilience measurement** — WRS, collateral, TTD/TTM   | **Overview** `/`           |
| 5   | Reporting              | Per-run + aggregate reports, remediations, compare, export       | **Reports** `/reports`     |

Phase 3 is **not** exploitation (bounded, allowlisted, authorized, capped HTTP —
no exploit/amplification/spoofing/evasion); phase 4 is **not** persistence (we
never maintain access, move laterally or install anything). Anything that could
only serve a phase by crossing that line stays in the attestation-only register
(HPACK bomb, WAF-cracker, brute-force, the L3/4 line). The phases form one loop:
recon seeds the plan, the plan orders the runs, runs are measured, reports drive
remediation, then re-profile and go again.

---

## 4. Tune-and-replay loop (close a weakness, measured)

Once a run surfaces a weakness, this loop closes it: **replay the same playbook
after each rule change and read the per-line WRS/verdict delta**, so every tuning
decision is measured, not judged by feel. It emits no new class of traffic — each
replay is the same bounded, allowlisted `pretest-cra-l7` playbook (12 L7 steps,
DRS 3→5). See `docs/pretest-p26-20371.md` for the line mapping.

**Start with the protection-gap planner** (Reports → _Protection-gap planner_ or
`POST /api/reports/gap-analysis`): declare each WEDOS control as
present/partial/absent/unknown; it returns a **DRS escalation ladder (3→4→5)**
with each rung's real capped intensity, **control chains with the weakest link
flagged**, a **predicted break point** (fix first — it gates everything above),
and the DRS5 combination lines. It only **selects and orders existing bounded
tests** — it never synthesises an attack or relaxes a cap.

The loop: **baseline replay** (Run sequence = "before") → **read weaknesses**
(per-step WRS/verdict + proposed remediations) → **tune ONE rule** (one change
per iteration, so the delta is attributable) → **replay** ("after") →
**compare** (Reports → Assessment suites → "Compare vs previous ↗", or
`GET /api/reports/suite-compare?a=<suiteId>&b=<suiteId>`) → keep the rule if
improved with no regression, else revisit. Repeat until every line meets its DRS
target.

Reading the delta: **▲ green** = WRS rose (better protection / less collateral);
**▼ red** = dropped (weaker protection, or it started hurting legitimate traffic
— check probe availability/latency); **`fixed`** = FAIL→PASS; **`regressed`** =
PASS→FAIL (a blocker, not a trade). A rule that fixes one line but regresses
another has collateral — prefer the best worst-step WRS with no regressions.

Ground rules: one rule change per replay; same playbook/target/caps (only the
WEDOS config differs); wire the scrubber hook (`PROTECTION_METRICS_URL`) so
TTD/TTM is measured; never widen the test to chase a target. Done when a line
meets its DRS target (customer targets capped at DRS 4.5) with no regression and
the suite SLO verdict is PASS — export each compare as the before/after evidence.
