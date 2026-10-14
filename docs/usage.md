# User journeys

## Validate the engine without traffic

1. Open **Campaigns → DRS assessment → New engine validation · no traffic**.
2. Choose the target level, edit the plan and save a new draft revision.
3. Freeze the plan and record capacity status.
4. Explicitly confirm a software fixture: healthy, generator saturation, service outage or telemetry gap.
5. Finalize and open JSON/HTML reports. A simulation score is labelled as simulation.

The scope is fictional (`simulation://fixture`), no target attestation or Fleet enrollment is required, and this campaign cannot dispatch a physical generator. Viewer accounts can read permitted records only.

## Bounded Fleet laboratory campaign

1. In Fleet, verify the intended agents' identities, sites and fresh authenticated heartbeats.
2. Select a supported GET laboratory approximation from the versioned catalogue, choose the laboratory mode and an explicitly approved target/origin.
3. Select exact agent IDs, set shared budgets within 3 agents, 15 requests/s, concurrency 6 and 10–60 seconds. No silent substitution or synthetic multiplier.
4. Save and freeze the assessment configuration; confirm the authorization and launch through the account's capabilities. Single-mode admin explicitly confirms each launch.
5. Follow Run Theater's graphs and compact live agent count. Unknown telemetry remains unknown; Kill requests stop and acknowledgments must be checked.
6. Read the campaign report and receipts in Fleet. Retain incomplete/failed evidence; a laboratory diagnostic is not full-standard DRS qualification.

Physical assessment baselines are observed for at least 300 seconds, extended up to the bounded 600-second window if unstable. The small injection-duration cap is separate from baseline observation. HTTP readiness is not a functional journey proof. Existing legacy runs can retain their older baseline contract.

## Measured evaluation

Prepare a versioned plan, qualify capacity and independently collect entry/origin/user/generator evidence. Import it through the governed DRS API and finalize. Full-standard measured dispatch is not enabled by merely selecting this mode. Missing collectors or required dimensions produce a partial/inconclusive report.

Archived campaigns remain readable and cannot be relaunched. Configuration changes create a new revision and retain prior attempts. See [DRS engine](drs-engine.md), [Fleet](fleet-management.md) and [access policy](single-user.md).
