# Pre-test runbook — DRS L7 playbook P26-20371

Rehearse the reproducible Layer-7 lines of the DRS **P26-20371** playbook
(ENISA/CRA portal, DRS 3→5) against an **authorized staging replica**, before
the external engagement — so the WEDOS protection is exercised and our own
playbooks are validated first.

**Hard rule.** We never emit toward the real ENISA production URLs
(`*.enisa.europa.eu`, `iam.melicertes.eu`). The pre-test only ever runs against
a staging replica that is on the allowlist and explicitly authorized. The
control plane (the app host, e.g. `10.20.2.1`) is only the tool — it needs a
target to point at.

## Line-by-line mapping

| #   | DRS | DRS line                                       | Reproduced by                                                          | Status                                       |
| --- | --- | ---------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| 1   | 3   | TCP-Handshakes                                 | class-C bench `tcp_synflood` / `tcp_maxpackets` (no-spoof state-table) | ✅ separate isolated runner                  |
| 2   | 3   | SlowLoris                                      | `pretest-cra-l7` SlowLoris step (`http-slowloris`, bounded hold)       | ✅                                           |
| 3   | 3   | HTTP GET-Flood                                 | `pretest-cra-l7` step 1                                                | ✅                                           |
| 4   | 3   | GET-Random-Flood                               | step 2 (non-existent paths → edge 404)                                 | ✅                                           |
| 5   | 4   | GET /VALID_RANDOM                              | step 3 (valid path set)                                                | ✅                                           |
| 6   | 4   | HTTP POST-Flood                                | step 4 (`http-post`)                                                   | ✅                                           |
| 7   | 4   | HTTP/2 GET-Flood                               | step 5 (k6, h2)                                                        | ✅                                           |
| 8   | 4   | HTTP/2 Rapid Reset / Continuation / HPACK Bomb | steps 6–7 (bounded h2 rate + header pressure)                          | ⚠️ partial — no RST abuse, **no HPACK bomb** |
| 9   | 5   | POST-Flood (login/account)                     | step 8 (`/realms/srp/account`)                                         | ✅                                           |
| 10  | 5   | HTTP MultiVector                               | step 9                                                                 | ✅                                           |
| 11  | 5   | Layer-7-THOR / PulseWave                       | step 10 (synchronized waves)                                           | ✅                                           |
| 12  | 5   | WAF-Cracker                                    | `threat-l7-signature-evasion` (approx.)                                | ⚠️ partial                                   |
| 13  | 5   | MultiTarget / carpet-bombing                   | step 11 + instantiate once per allowlisted CRA host                    | ✅ via suite                                 |
| 14  | 4   | RANDOM POST / LOGIN_BRUTE_FORCE                | POST covered; brute-force **not** (bounded flow only, by design)       | ⚠️ partial                                   |

The one-click playbook is **`pretest-cra-l7`** (12 bounded L7 steps, DRS 3→5).
To iterate on the protection after a run, see the tune-and-replay loop
(`docs/measurement.md`): replay this playbook after each WEDOS rule change
and read the per-line WRS/verdict delta.

## What the teams need to provide

The app host alone is not enough. To run the L7 pre-test we need:

1. **A staging target** — a replica of the CRA platform **behind the same WEDOS
   protection**, reachable over HTTPS with **HTTP/2** enabled (lines 7–8).
2. **Authorization + allowlist entry** — add the staging hostname to
   `ALLOWED_TARGETS` on the app host, and confirm we are cleared to load-test it
   (each campaign is created with an authorization attestation).
3. **Network path** — routing/firewall so the app host can reach the target;
   outbound open.
4. **Protection hook to the WEDOS scrubber** — set `PROTECTION_WEBHOOK_URL` (or
   `PROTECTION_METRICS_URL`) + `PROTECTION_SOURCE_LABEL`. Without it, detect /
   mitigate timing is only _estimated_, so the pass/fail criterion ("detected +
   mitigated ≤ DRS4 instantly, without blocking source IPs") cannot be formally
   proven. This is the piece that makes each line pass or fail.

For the **one L3/4 line** (TCP-Handshakes) additionally:

5. **A separate, isolated runner host** for the class-C bench, plus
   `LAB_TARGETS` + `BENCH_RUNNER_TOKEN` on the app host. It must **not** be the
   app host — the control plane never emits volumetric traffic itself.

## How to run (once the above is in place)

1. Add the staging host to `ALLOWED_TARGETS`; restart the app host.
2. Wire the protection hook env; confirm `/health` shows `protection` configured.
3. In the UI, instantiate the **`pretest-cra-l7`** playbook against the staging
   target (Security Engineer creates, Security Officer approves). For the
   MultiTarget line, instantiate once per allowlisted CRA host.
4. Read the per-run and aggregate assessment reports; each line carries its DRS
   level, WRS, and — with the hook wired — real detect/mitigate timing and
   collateral on the legitimate probe.
5. The TCP-Handshake line runs separately on the class-C bench once its isolated
   runner is active.

## Gap register — not emitted, and why

Each gap is stated with its disposition: whether it _could_ be a bounded vector
we build, or is deliberately out on safety grounds. The security boundary is the
same one that keeps the whole platform defensible: bounded, allowlisted,
authorized, capped — no exploits, no amplification, no spoofing.

- **SlowLoris (line 2)** — _built._ Bounded slow-header vector (`http-slowloris`):
  opens up to `concurrency` connections and trickles partial headers to hold
  them for `durationSec`, measuring whether the edge sheds slow/incomplete
  requests (good) or lets them accumulate (bad). Capped on every axis
  (connections ≤ concurrency, lifetime ≤ duration, kill-switch), allowlisted and
  authorized — no exploit, just incomplete rate-capped requests. Now step 2 of
  `pretest-cra-l7`.
- **HPACK bomb (line 8c)** — _out by design (safety)._ A real HPACK bomb is a
  header-decompression **amplification exploit** — precisely the amplification/
  exploit class the platform never emits, at L7 instead of L3/4. We reproduce
  the benign shape (bounded large header sets over h2, the Continuation step)
  and cover the exploit itself by **attestation** of the server's HPACK table
  size limit, not by firing one.
- **WAF-Cracker (line 12)** — _out of the inert bounded model._ A real WAF
  cracker sends live attack payloads (SQLi/XSS/RCE) to break the WAF. We
  approximate the _signature-rotation shape_ with `threat-l7-signature-evasion`
  (benign markers), and cover WAF efficacy by **attestation** of the WAF ruleset
  / paranoia level rather than launching weaponized payloads at the target.
- **Credential brute-force (line 14b)** — _out by design._ We run a bounded POST
  flow, never a credential brute-force.

These are declared honestly in the assessment so a reader sees the full DRS
matrix and exactly where each part is validated, attested, or intentionally not
emitted. SlowLoris is now built (coverage **12 of 14**); the remaining three
(HPACK bomb, WAF-cracker, credential brute-force) stay out on principle.
