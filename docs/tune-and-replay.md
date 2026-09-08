# Tune-and-replay runbook — iterate WEDOS rules against bank.cz

Once the pre-test surfaces a weakness, this is the loop that closes it: **replay
the same playbook after each WEDOS rule change and read the per-line WRS/verdict
delta**, so every tuning decision is measured line-by-line rather than judged by
feel. The engagement target is the authorized external test target **`bank.cz`**.

This is an analytical loop layered on top of the existing assessment: it emits
no new class of traffic. Every replay is the same bounded, allowlisted,
authorized `pretest-cra-l7` playbook (12 L7 steps, DRS 3→5). See
`docs/pretest-p26-20371.md` for the line-by-line mapping and
`docs/assessment-methodology.md` for how WRS is derived.

## Where to start — the protection-gap planner

Before the first replay, use the **protection-gap planner** (Reports →
_Protection-gap planner_, or `POST /api/reports/gap-analysis`) to decide **which
lines to replay first**. You declare the target's WEDOS controls — rate limiting,
slow-request timeout, HTTP/2 guard, bot challenge, WAF ruleset, … — each as
`present` / `partial` / `absent` / `unknown`, and it returns:

- a **prioritised replay plan**: the bounded `pretest-cra-l7` lines ranked by DRS
  level and how weakly the mitigating control is declared (an absent control on a
  DRS-5 line ranks highest), each naming the exact step to replay and why;
- the **attestation-only** lines (TCP handshake on the class-C bench, HPACK bomb,
  WAF-cracker, credential brute-force) that stay out of the bounded model.

It is analytical only: it **selects and orders existing bounded tests** against
the authorized target from the declared defense — it never synthesises an attack,
crafts an evasion payload, or relaxes a cap/allowlist. Knowing the defense only
tells you where to point the same governed test first, not how to defeat a rule.
Work the plan top-down through the loop below.

## The loop

```
 ┌─ 1. Baseline replay ─────────────────────────────────────────┐
 │  Instantiate pretest-cra-l7 against https://bank.cz/,         │
 │  Run sequence. This suite is your "before".                   │
 └───────────────────────────────────────────────────────────────┘
                          │
 ┌─ 2. Read the weaknesses ─────────────────────────────────────┐
 │  Suite report → per-step WRS/verdict + the remediations the   │
 │  assessment proposes for every FAIL / low-WRS line.           │
 └───────────────────────────────────────────────────────────────┘
                          │
 ┌─ 3. Tune ONE thing in WEDOS ─────────────────────────────────┐
 │  Change a single rule (rate limit, challenge, header/slow     │
 │  timeout, WAF paranoia…). One change per iteration so the     │
 │  delta is attributable.                                       │
 └───────────────────────────────────────────────────────────────┘
                          │
 ┌─ 4. Replay ──────────────────────────────────────────────────┐
 │  Instantiate pretest-cra-l7 against bank.cz AGAIN and Run     │
 │  sequence. Same playbook, same target → new suite = "after".  │
 └───────────────────────────────────────────────────────────────┘
                          │
 ┌─ 5. Compare ─────────────────────────────────────────────────┐
 │  Reports → Assessment suites → "Compare vs previous ↗" on the │
 │  newest suite. Per-line WRS before→after, Δ, and which lines  │
 │  were fixed vs regressed.                                     │
 └───────────────────────────────────────────────────────────────┘
              │ improved & no regressions → keep the rule, next weakness
              │ regressed elsewhere → the change had collateral, revisit
              └─ repeat until every line meets its DRS target
```

## How to compare two replays

The **suite-compare** pairs two suites of the same playbook by step order and
shows, per playbook line: WRS + level + SLO verdict for A (before) and B
(after), the signed WRS delta, and a `fixed` / `regressed` marker when the
verdict flips.

- **UI** — Reports → _Assessment suites_. Each suite that has an earlier replay
  of the same playbook on the same target shows **"Compare vs previous ↗"**,
  which opens `A = previous replay`, `B = this replay`. Print/PDF for the record.
- **API** — `GET /api/reports/suite-compare?a=<suiteId>&b=<suiteId>` (read
  token). `a` is the baseline, `b` the newer replay. Returns the same HTML.

The header summarises `worst-step WRS <before> → <after>`, the average, the
count of improved / regressed / unchanged steps, and any SLO verdict flip.

## Reading the delta

- **▲ green** — WRS rose after the rule change: better protection and/or less
  collateral on the legitimate probe. This is the goal.
- **▼ red** — WRS dropped. Either the rule weakened protection, or it started
  hurting legitimate traffic (collateral) — check the per-step report's
  availability/latency on the probe before keeping the change.
- **`fixed`** — the step's SLO verdict went FAIL → PASS. **`regressed`** — PASS →
  FAIL; treat as a blocker, not a trade.
- A rule that fixes one line but regresses another has **collateral**. Prefer the
  change with the best worst-step WRS and no regressions — the worst step is what
  the aggregate suite verdict tracks.

## Ground rules

- **One rule change per replay.** Two changes at once make the delta
  un-attributable; you learn nothing about which one worked.
- **Same playbook, same target, same caps.** Only the WEDOS configuration should
  differ between A and B — otherwise you are comparing apples to oranges. Keep
  `ALLOWED_TARGETS=bank.cz` and the operational caps fixed across the loop.
- **Wire the scrubber hook** (`PROTECTION_METRICS_URL`, see
  `docs/provisioning-4vps.md`). Without it, detect/mitigate timing is _estimated_
  and the pass/fail per line cannot be formally proven — the WRS delta still
  moves, but you lose the TTD/TTM evidence that justifies the rule.
- **Never widen the test to chase a target.** The security boundary is unchanged:
  bounded, allowlisted, authorized, capped — no exploit, amplification or
  spoofing. If a line can only "pass" by emitting something out of that model, it
  stays in the gap register, not in the loop.
- `pretest-cra-l7`'s login step targets `/realms/srp/account`; against `bank.cz`
  set the step's path to bank.cz's real login route or expect a 404 on that line
  (see `docs/provisioning-4vps.md`).

## When are you done

Stop iterating a line when its WRS meets the DRS target for that line (customer
targets are capped at DRS 4.5 — see `docs/drs-validation-policy.md`) with no
regression on any other line and the suite SLO verdict is PASS. Export each
compare (Print / PDF) as the before/after evidence for that rule change.
