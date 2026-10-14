# ShieldTester ↔ shieldtest-lab contract

This file mirrors the [lab-side contract](https://github.com/abdelhasoloji/shieldtest-lab/blob/main/docs/cross-repo-contract.md). The control plane manages approval, identity, records and reports; the bench executes only its registered confined scenarios and returns artifacts.

## Governed dispatch

`POST /api/bench/runs/next/claim` gives a named authorized scenario to a runner; `POST /api/bench/runs/:id/result` records its result. Runner authentication uses the dedicated `BENCH_RUNNER_TOKEN`, not a user JWT. `BENCH_API_URL`, token and runner identity are operator configuration. Target labels are laboratory labels, not arbitrary target/rate/port instructions. Dispatch fails closed when required configuration/authorization is absent.

`GET /protection` on the bench scrubber exposes detection/mitigation source and timing; `GET /telemetry` on the bench target exposes `nicRxMbps`. Optional control-plane protection/target providers read these summaries. Configured provider flags do not prove independently acquired complete DRS instrumentation. Preserve provenance and actual units.

## DRS archive

The DRS attachment route archives an existing same-target run or completed isolated bench result. Attachments are diagnostic; complete vector verdicts require the separately validated evidence model, four instrument roles, functional transactions, baseline/recovery and calibration. Measured imported proof remains labelled collector-import.

The plan's standard version, catalogue hash and engine/profile must accompany the assessment. A synthetic factor never scales a received counter. Simulated and physical observations remain distinguishable. See [DRS engine](drs-engine.md).

## Ownership and stop

The bench retains network confinement and fixed scenario budgets. Fleet remains the control repository's separate bounded HTTP mission path. A lost runner or absent artifact yields incomplete evidence, not PASS. Private keys and tokens remain outside both repositories. No public reflector or raw-packet emitter is enabled by this integration.
