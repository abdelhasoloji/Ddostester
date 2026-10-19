# WEDOS defence playbook — L7 HTTP flood

Operational guide for rehearsing WEDOS's L7 defences against a hacktivist-style
HTTP flood. It describes what to run, how to read the result, and what the result
does **not** prove.

Authorized targets only: the host must be on the allowlist, the campaign goes
through approval, and the kill switch stays available for the whole run. This is a
bounded generator, not a botnet: every request comes from the operator's own
egress address.

## 1. What to run

| Scenario                      | Template                       | Steps                                                                                                                                   |
| ----------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Cache-busted multi-path flood | `threat-l7-cache-busted-flood` | baseline → cache-busted GET wave (5 paths, rotating browser UA, `parallelism: 3`) → login/session POST burst → non-browser client burst |
| Randomised multi-path flood   | `threat-l7-signature-evasion`  | baseline → wave with rotating UA                                                                                                        |
| DRS 3→5 rehearsal             | `pretest-cra-l7`               | ordered DRS L7 lines, terminal level 5                                                                                                  |

The cache-busted template is the closest match to a cache-evading L7 flood: a
unique query token per request means the edge cannot absorb the run, so the
measurement is origin exposure rather than cache hit ratio. Its fourth step carries
`curl` and `python-requests` User-Agents on purpose — that exercises UA-based bot
rules, a different detection path from browser blending.

## 2. Run it

1. Add the **staging** address to `ALLOWED_TARGETS` (or authorize it through the
   target registry). Never point this at production customer traffic.
2. Campaigns → Threat-informed → pick the template.
3. Confirm the target, the rate and the duration; approve; run.
4. Keep an eye on the probe (availability, 5xx, p95) — the kill switch is there
   for a reason.

## 3. Reading the result

| Signal                     | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `absorption.absorbedRatio` | share of the offered load the edge did not pass through (rejected or tarpitted)    |
| `rejectedRatio`            | fraction answered with 4xx/5xx — the WAF or rate limiter refusing                  |
| `tarpitRatio`              | fraction held until timeout/abort — connection-level shedding, not a policy answer |
| probe availability / p95   | whether legitimate traffic still worked **while** the flood ran                    |
| `confidence.degraded`      | the generator host was itself the bottleneck; the number is not about the target   |

A WAF that blocks every request but also blocks the probe is not a pass: the
verdict counts legitimate availability, not just blocked volume.

## 4. DRS5 amplitude (500–1,000 rps)

The individual DRS L7 lines already exist at 500, 800 and 1,000 rps, and the
composite `pretest-cra-l7` runs the ordered 3→5 sequence. Two mechanics matter:

- `BUILTIN_RPS_CEILING` (150 rps) is a **routing threshold**, not a hard engine
  limit: above it a step auto-routes to vegeta or k6, and a step that cannot be
  routed is refused rather than silently under-delivered
  (`builtinUnderDeliveryReason`). Measured on loopback, the pacer itself delivers
  1,000 rps cleanly (6,000 requests, 0 failed, max 59 ms event-loop lag), so the
  150 figure reflects real-target conditions — TLS, remote latency, probe
  contention — not the scheduler. Capacity is latency-bound: roughly
  `concurrency / latency`.
- High-rate lines carry `calibrate: true`: the run measures the deliverable rate
  and grades there. A reduced exposure stays inconclusive for the original
  conditions — it is not a pass.

Do not raise `HARD_CAPS` to reach an amplitude. The ceiling is the safety boundary;
if the target needs more than 2,000 rps to be exercised, that is a capacity
decision with its own review, not a configuration tweak.

## 5. Distribution across sites

`ac02` exists to make an authorized aggregate **deliverable**, not larger: the
envelope is computed once (`min(HARD_CAPS, FLEET_LIMITS, site policy)`) and divided
across agents. Two sites are two egresses — that is not the hundreds of hosts a
botnet uses, and per [boundary and lab](boundary-and-lab.md) pods behind one public
egress do not establish source diversity. Report it as origin diversity, never as
"botnet-scale".

Deployment steps, the image digest, the WireGuard path and the certificate SAN
requirement are in [ac02 site readiness](ac02-site-readiness.md). The site label is
provenance, not authorisation: the certificate is what proves an agent's identity.

## 6. What this does not establish

- No attribution: a scenario name says which traffic pattern it approximates, not
  who will attack.
- No fidelity claim: the templates reproduce a bounded HTTP shape, not an actor's
  tooling, botnet or coordination.
- No certification: a PASS is evidence about this run against this target, not a
  statement about WEDOS's defence in general.
- No spoofing: at L7 the relevant signal is the request, and every request is sent
  from the operator's own address.
