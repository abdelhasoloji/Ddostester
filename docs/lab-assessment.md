# ShieldTest Lab — état des lieux & expansion plan (E7)

Assessment of the isolated bench [`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab)
and a concrete plan to extend it "to the maximum" — with the matching product
improvements here in the control plane. Every claim is sourced to a filename in
the lab repo (`lab:`) or this repo.

> **Boundary (never weakened).** The lab is a **closed synthetic measurement
> model, not an amplifier**. No source-IP spoofing, no real reflector protocols,
> hard caps on every axis, an `internal: true` Compose network with no published
> ports, a loopback-only console, and a non-bypassable RFC1918/loopback address
> guard (`lab:lib/net-guard.mjs`). It connects to this control plane **only**
> through a read-only, governed verdict contract (UDP amplification = **class
> C**, `docs/drs-validation-policy.md`). The control plane never opens an
> amplification socket; the lab never touches a production network
> (`lab:CLAUDE.md`).

## 1. What the lab is today (sourced)

| Capability                       | Where                                                           | Notes                                                                                                                                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Address guard**                | `lab:lib/net-guard.mjs`                                         | Real octet-math RFC1918 + 127/8 gate; cannot be widened by config (`isLabAddress`, `assertLabAddress`).                                                                                                                                                                             |
| **Amplification profiles**       | `lab:profiles.mjs`                                              | 5 byte/packet **shape** presets: `generic` (×10), `dns` (×40), `ssdp` (×30), `ntp` (×100, pkt ×6), `memcached` (×100, pkt ×10). `referenceBap` keeps the real-world figure for comparison; the effective factor is whatever survives the caps.                                      |
| **Rate shapes**                  | `lab:generator/generate.mjs:17`                                 | `constant` / `ramp` / `wave` / `burst`, each within `[0, basePps]`.                                                                                                                                                                                                                 |
| **Hard caps**                    | `lab:generator/generate.mjs:45-75`                              | `MAX_PPS=500`, `MAX_DURATION_SEC=60`, `MAX_PACKET_FACTOR=10`; reflector adds `MAX_RESPONSE_BYTES` / `MAX_FACTOR` (`lab:synthetic-reflector/server.mjs`).                                                                                                                            |
| **Scrubber (mitigation model)**  | `lab:scrubber/server.mjs`                                       | Strategies `blocklist` + `adaptive`; `THRESHOLD_PPS`, `CEILING_PPS`, `DETECTION_DELAY_SEC`; exposes `GET /protection` → `detectionTimeSec, mitigationTimeSec, strategy, source`.                                                                                                    |
| **TCP connection-pressure path** | `lab:tcp-generator/generate.mjs`, `lab:tcp-target/receiver.mjs` | A second dimension: state-table saturation, outcomes `STATE_TABLE_SATURATED` / `ABSORBED` (`lab:verdict.mjs`).                                                                                                                                                                      |
| **Named scenarios**              | `lab:scenarios.mjs`                                             | ~13 curated, allowlisted configs (amplification-ramp, packet-rate-stress, mitigation-delay-study, collateral-study, wave/burst/progressive detection, multi-profile-mix, mixed-flood-with-legit, blocklist/adaptive mitigation). The lab's answer to the control plane's playbooks. |
| **Verdict artifact**             | `lab:verdict.mjs`                                               | `schema shieldtest.lab.verdict/v1`, `class: 'C'`, outcomes (`UNMITIGATED_BASELINE`, `NOT_MITIGATED`, `MITIGATED`, `MITIGATED_WITH_COLLATERAL`, `STATE_TABLE_SATURATED`, `ABSORBED`); carries amplification factor, detection delay, mitigation efficacy, collateral.                |
| **Governed runner**              | `lab:runner.mjs`                                                | Claims authorized runs from the control plane (`BENCH_API_URL` + `BENCH_RUNNER_TOKEN`), posts the verdict back (`POST /api/bench/runs/:id/result`).                                                                                                                                 |
| **Console + metrics**            | `lab:console/server.mjs`, Prometheus text                       | Loopback-only UI; the same numbers scrape into Prometheus.                                                                                                                                                                                                                          |
| **Safety invariants**            | `lab:test/*.test.mjs`                                           | `net-guard`, `fuzz-caps`, `amplification`, `mitigation-strategies`, `closed-loop`, `scrubber`, `verdict`, `tcp` — the safety net.                                                                                                                                                   |

**How it feeds the product (sourced).** `docs/cross-repo-contract.md`: the runner
posts the class-C verdict to `app.ts:1056-1118`; the scrubber's `GET /protection`
(`lab:scrubber/server.mjs:249-253`) feeds `detectionTimeSec / mitigationTimeSec /
strategy` into this repo's `PollProtectionProvider` via `PROTECTION_METRICS_URL`
— i.e. the lab can supply **real measured TTD/TTM** to a run's WRS, not an
estimate.

## 2. Current limits

- **One reflected vector family** (UDP amplification) + one TCP dimension. No
  direct-flood UDP, no SYN-flood shape, no fragmented/mixed L3/4.
- **5 profiles**, all reflection-shaped; several high-BAP real vectors are
  missing (CLDAP, chargen, RIPv1, ARMS, WS-Discovery, TFTP, QOTD).
- **2 mitigation strategies** (blocklist, adaptive). No rate-limit / SYN-cookie /
  anycast-shift / BGP-blackhole / fair-queue models.
- **Verdict is a point summary** — limited time-series (amplification-factor and
  collateral over time, per-source breakdown, false-positive rate are not
  first-class).
- **Class-C only**, standalone: it is deliberately never posted to
  `POST /api/drs-validations` (class A/B only). Good for the boundary, but the
  product surfaces the lab thinly (bench dispatch + a protection provider) rather
  than as a first-class scorecard.

## 3. Expansion plan — extend to the maximum

Ordered by value ÷ effort. Each keeps the hard boundary intact.

### Lab side

1. **More amplification profiles** (`lab:profiles.mjs`): add `cldap` (×56–70),
   `chargen` (×358), `ripv1` (×131), `arms` (×33), `ws-discovery` (×300+),
   `tftp`, `qotd` — pure shape presets, still clamped. Instantly widens coverage
   with near-zero risk.
2. **More rate shapes** (`lab:generator/generate.mjs`): `pulse` (synchronised
   on/off à la Pulse-Wave/THOR), `carpet` (many low-rate sources → one target),
   `stair` (stepped ramp). Mirrors the L7 shapes the control plane already
   models, so verdicts line up across layers.
3. **New mitigation strategies** (`lab:scrubber/server.mjs`): `rate-limit`
   (per-source token bucket), `syn-cookie` (TCP path), `anycast-shift` (model
   draining a PoP), `fair-queue`, `bgp-blackhole` (coarse null-route with
   collateral). Turns the bench into a **strategy comparison** rig — same attack,
   many defenses, ranked by collateral vs. residual.
4. **Richer telemetry** (`lab:verdict.mjs` + metrics): first-class time-series
   (amplification factor over time, residual-to-origin bps, collateral %),
   per-source breakdown, and an explicit **false-positive rate** (legit dropped ÷
   legit offered). Add `TTD`/`TTM` to the verdict top-level (already measured by
   the scrubber).
5. **New class-C sub-kinds**: split `class C` into `reflection`,
   `direct-udp-flood`, `tcp-state-exhaustion` so the score can weight them
   differently.
6. **Closed-loop scoring**: extend `lab:test/closed-loop.test.mjs` into a runnable
   "attack → detect → mitigate → measure residual" verdict, the network analogue
   of the L7 Mitigation-Proof compare here.

### Product side (this control plane consumes the expansion)

7. **First-class lab scorecard**: surface the class-C verdict where the WRS lives
   — a network-resilience panel (BAP, TTD, TTM, collateral, outcome) beside the
   L7 WRS, sourced from the verdict artifact. The plumbing exists
   (`describeAgents`-style bench dispatch: `benchScenarios / benchRuns /
benchCoverage` in `frontend/src/api.ts`); it needs a real surface.
8. **Lab scenario catalogue in the UI** (mirror playbooks): list the named
   scenarios (`lab:scenarios.mjs`) as a governed, one-click bench catalogue with
   coverage tracking, exactly like L7 templates.
9. **Cross-layer Mitigation-Proof**: reuse this repo's before/after compare
   (`modules/reports/compare.ts`) on two lab verdicts (no-scrubber vs. adaptive)
   to show mitigation efficacy as a network DRS ladder rung.
10. **DRS ladder rows for the new sub-kinds**: the plan page's DRS escalation
    ladder gains network rungs fed by the expanded verdicts.

## 4. Guardrails for every expansion

- Never add a real protocol client, never read a destination from a packet, never
  publish a host port — extend `lab:test/*.test.mjs` invariants first.
- Every new profile/shape/strategy is a **named, allowlisted** config
  (`lab:scenarios.mjs`) — the runner still accepts only names, never arbitrary
  host/port/rate.
- The control plane keeps ingesting **read-only** class-C verdicts; it never runs
  the lab and never opens an amplification socket (`docs/drs-validation-policy.md`).
