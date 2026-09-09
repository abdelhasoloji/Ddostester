# The five-phase model — offensive lifecycle, bounded

WEDOS ShieldTest is organised around the five phases of an offensive engagement,
**adapted to a defensive, bounded model**. We keep the _structure_ of the
lifecycle — it makes an assessment legible end to end — but never its weaponised
arsenal. Phases 3 and 4 are rendered by their **bounded analogues**; the real
offensive versions (exploitation, persistence) are deliberately not implemented.

| #   | Offensive phase (classic) | ShieldTest (bounded)                                                        | Where                        |
| --- | ------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| 1   | Reconnaissance            | Passive + published-surface recon: posture, surface, baseline, preflight    | **Preparation** (`/prepare`) |
| 2   | Scanning / enumeration    | Gap analyzer: declared/observed defenses → DRS ladder, weakest link, break  | **Plan** (`/plan`)           |
| 3   | Exploitation / access     | **Bounded load delivery** — governed, capped playbook/suite runs            | **Campaigns** (`/campaigns`) |
| 4   | Maintaining access        | **Impact & resilience measurement** — WRS, collateral, TTD/TTM, DRS verdict | **Overview** (`/`)           |
| 5   | Reporting                 | Per-run + aggregate reports, remediations, suite-compare, verdict export    | **Reports** (`/reports`)     |

## The boundary that governs the adaptation

Respecting the five phases means adopting the lifecycle's **spine**, not its
weapons. Concretely:

- **Phase 3 is not exploitation.** We deliver bounded, allowlisted, authorized,
  rate-capped HTTP (and the governed class-C bench on an isolated runner). No
  exploit, no amplification, no spoofing, no evasion payloads. "Gaining access"
  becomes "delivering a governed load and seeing whether the edge holds".
- **Phase 4 is not persistence.** We never maintain access, move laterally, or
  install anything. "Maintaining access" becomes "measuring how resilience and
  collateral behave under sustained bounded load" — WRS, availability on the
  legitimate probe, and detect/mitigate timing from the protection hook.
- Phases 1, 2 and 5 are faithful to the originals because they are already
  non-destructive: observe, model, report.

If a capability can only serve a phase by crossing that line, it stays out — in
the attestation-only register (HPACK bomb, WAF-cracker, credential brute-force,
the L3/4 handshake line), validated by attestation rather than emitted.

## How the phases hand off

The phases form one loop, each feeding the next:

1. **Recon → Plan.** The observed posture seeds the gap-analyzer control profile;
   the published surface gives real paths; the baseline sets the collateral
   reference.
2. **Plan → Execute.** The prioritised DRS ladder says which bounded playbook
   lines to run first, and in what order (climb the ladder; fix the break point
   before climbing).
3. **Execute → Measure.** Each run records WRS, collateral on the probe, and —
   with the protection hook wired — real TTD/TTM.
4. **Measure → Report.** Per-line and aggregate reports, remediations, and the
   suite-compare that drives the tune-and-replay loop
   (`docs/tune-and-replay.md`).
5. **Report → Recon.** Re-profile after a rule change and go round again.

The **phase rail** in the UI threads the existing pages in this order and marks
where you are, so the whole engagement reads as one governed cycle rather than a
set of disconnected tools.

See also: `docs/pretest-p26-20371.md` (the zeroBS line mapping),
`docs/tune-and-replay.md` (the iterate-on-rules loop), and
`docs/ethical-boundary-map.md` (the full boundary).
