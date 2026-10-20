# DRS service — operator guide

The product runs one thing: a DRS 3.00.00 assessment for a client. This is how it is used,
and what it refuses to claim.

## The flow

1. **Capacity.** An agent is only counted once it has a recorded calibration: the rate it
   actually sustained and the concurrency it held, with the conditions. The envelope is
   `min(signed scope, measured capacity, service ceiling)`; the ceiling is configurable
   (`SERVICE_CEILING_RPS`, clamped by the immutable hard cap) and defaults to the cap, so
   nothing escalates silently.
2. **Plan.** Choose the client, the target, the level (1–7), the exposure and the baseline,
   write the functional assertion and the rationale, attest authorization. The plan is
   frozen with a digest and its budgets are clamped to the envelope.
3. **Execution.** The orchestrator runs capacity check → baseline → exposure → recovery →
   evidence validation. Only the bounded HTTP GET line is dispatchable; the other vectors
   of the level stay in the denominator as `excluded`, with a reason.
4. **Verdict.** The assessment states PASS/FAIL/PARTIAL and, next to it, the archived
   requirement versus what was recorded, per vector and dimension. A verdict that is not a
   pass always says why.
5. **Report.** HTML and JSON per revision, hash-chained. Replay clones the plan into a new
   campaign and re-derives the envelope from the fleet as it is now.

## What it does not claim

- **No certification.** `certification: false` is part of the assessment.
- **No witness, no pass.** Without independent entry/origin observation the evidence marks
  those dimensions unrepresented and the verdict cannot be a pass.
- **No fabricated scale.** A vector whose load or `max_bots` requirement exceeds the admitted
  fleet is reported unmet — with the numbers — instead of being graded on traffic that never
  happened.
- **Kubernetes produces requests, not bandwidth.** Volumetric (`bps`/`pps`) and source
  diversity remain unmet and are reported as such.

## Operator knobs

| Variable                                             | Default     | Purpose                                                                               |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `SERVICE_CEILING_RPS` / `_CONCURRENCY` / `_DURATION` | hard cap    | outer limit the deployment will operate at                                            |
| `SERVICE_CEILING_AGENTS`                             | 3           | admitted identities the ceiling allows                                                |
| `DRS_BASELINE_FLOOR_SEC`                             | 300         | minimum baseline before injection; lower only deliberately                            |
| `TRUST_PROXY`                                        | `127.0.0.1` | peer allowed to set `X-Forwarded-For`; audit and login throttling record that address |

## Fast path

CI gates a merge in ~5 minutes; deployment builds and promotes in **~1 min 30 s**, and
superseded CI runs are cancelled so a rapid sequence of merges does not queue behind stale
commits.
