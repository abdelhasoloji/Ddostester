# API reference

Base: `http://127.0.0.1:8080` (via SSH tunnel). JSON responses, except the report
(HTML). No traffic is emitted toward a target outside `ALLOWED_TARGETS`.

## `GET /health`

Service status and allowed targets.

```bash
curl -s localhost:8080/health
# {"status":"ok","allowedTargets":["127.0.0.1","localhost"]}
```

## `POST /api/campaigns`

Creates a campaign with status `PENDING_APPROVAL`.

Body:

| Field            | Type                      | Notes                                                                                                                         |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string                    | required                                                                                                                      |
| `createdBy`      | string                    | required (author)                                                                                                             |
| `target`         | string (URL)              | must be in the allowlist                                                                                                      |
| `probeUrl`       | string (URL)              | probed endpoint, in the allowlist                                                                                             |
| `vector`         | `http-get` \| `http-post` | only supported vectors                                                                                                        |
| `body`           | string                    | for `http-post`                                                                                                               |
| `headers`        | object                    | additional headers                                                                                                            |
| `maxRps`         | number                    | > 0, ≤ 2000                                                                                                                   |
| `concurrency`    | number                    | 1..500                                                                                                                        |
| `maxDurationSec` | number                    | 1..900                                                                                                                        |
| `authorized`     | bool                      | must be `true` (attestation)                                                                                                  |
| `scheduledAt`    | string ISO                | optional — auto-run by the scheduler once approved (CAM-01)                                                                   |
| `scenario`       | phase[]                   | optional — bounded scenario (GEN-03): `[{maxRps,durationSec}, …]` (≤12 phases). Normalizes `maxRps`=max, `maxDurationSec`=sum |

```bash
curl -s -X POST localhost:8080/api/campaigns -H 'content-type: application/json' -d '{
  "name":"Resilience UAT",
  "createdBy":"eng@wedos",
  "target":"http://127.0.0.1:8080/health",
  "probeUrl":"http://127.0.0.1:8080/health",
  "vector":"http-get",
  "maxRps":20,"concurrency":5,"maxDurationSec":30,
  "authorized":true
}'
```

## `GET /api/campaigns` — list

## `GET /api/campaigns/:id` — detail

## `POST /api/campaigns/:id/approval`

Approve or reject (Security Officer). Separation of duties: `approvedBy` ≠ author.

```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/approval -H 'content-type: application/json' \
  -d '{"approvedBy":"officer@wedos","decision":"APPROVED"}'
# rejection: {"approvedBy":"officer@wedos","decision":"REJECTED","reason":"out of window"}
```

## `POST /api/campaigns/:id/execute`

Executes an `APPROVED` campaign. Returns the run (generator + probe + WRS).

```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/execute
```

## `GET /api/campaigns/:id/stream`

Real-time progress SSE stream during execution (CAM-04): events
`{sent, successful, failed, elapsedSec, actualRps, maxDurationSec, status:"RUNNING"}`
~1×/s. Before load begins (the awaited pre-load baseline capture) or between
suite steps it emits `{status:"waiting"}` keepalives, and only sends
`{status:"done"}` — closing the stream — once the campaign is terminal. Token
via `?token=` (EventSource).

## `POST /api/campaigns/:id/kill`

Manual kill switch (level 2) of a running campaign.

```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/kill
# {"status":"KILLED_MANUAL"}
```

## `GET /api/runs/:runId` — raw run result

## `GET /api/runs/:runId/report` — HTML report

```bash
curl -s localhost:8080/api/runs/<runId>/report -o report.html
```

## Error codes

| Code | Cause                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------- |
| 400  | invalid config (missing attestation, cap exceeded, target outside allowlist, forbidden transition) |
| 404  | campaign / run not found                                                                           |
| 500  | internal error                                                                                     |

## `GET /metrics`

Prometheus metrics (text format 0.0.4): campaigns by status, total runs, last WRS
per target. Unauthenticated (loopback, non-sensitive aggregates).

## `GET /api/reports/compliance`

Aggregated compliance report (DORA/NIS2/ISO 27001) in HTML. Optional `from`/`to`
query (ISO). Token via `?token=` accepted for browser opening.

## `GET /api/agents`

Load engines and their live availability. Returns `{ default, agents }` where
each agent is `{ id, name, available, multiPhase, description }`. Used by the UI
to populate the per-campaign engine selector and the Settings list. A campaign
picks an engine via the optional `agent` field (its `id`, e.g. `"k6"`); absent =
the server default. Creating a campaign with an unknown engine, or a multi-phase
scenario on a constant-only engine, is rejected (400).

```bash
curl -s localhost:8080/api/agents
# {"default":"builtin-http","agents":[{"id":"builtin","name":"builtin-http","available":true,"multiPhase":true,...}, ...]}
```

## `GET /api/recon?target=&probeUrl=`

Preparation-phase reconnaissance (`campaign:read`). Passive + published-surface
recon of an **allowlisted, authorized** target → a `ReconReport`: target profile
(vendor, HTTP/2+3, cache, posture), published-surface path set + login path,
pre-test baseline (availability + latency p50/p95), a preflight `{items, go}`
checklist, and the gap-analyzer control profile seeded from the observed posture.
Refuses off-allowlist hosts (400). Non-intrusive: no port scan, no vulnerability
scan, no path fuzzing/brute-force, no enumeration of non-published resources.

## `GET /api/limits`

The caps the server enforces. Any authenticated reader. Returns the immutable
ceiling and the effective operational limits:

```jsonc
{
  "ceiling": { "maxRps": 2000, "maxConcurrency": 500, "maxDurationSec": 900 },
  "effective": { "maxRps": 2000, "maxConcurrency": 500, "maxDurationSec": 900 },
}
```

`/health` also carries these as `hardCapsCeiling` (ceiling) and `hardCaps`
(effective).

## `PUT /api/limits`

**CISO only** (`limits:manage`). Sets the operational limits (the effective
caps). Each field must be an integer within `[1, ceiling]`; a value above the
immutable `HARD_CAPS` ceiling — or non-integer / `< 1` — is rejected `400`, and
the accepted value is re-clamped `≤ ceiling` server-side. The change is written
to the audit chain (`limits.update`). Returns the same shape as `GET`.

```bash
curl -sX PUT localhost:8080/api/limits -H "authorization: Bearer $CISO" \
  -H 'content-type: application/json' \
  -d '{"maxRps":500,"maxConcurrency":100,"maxDurationSec":300}'
```

## `GET /api/audit`

Audit log (read). `limit` query (default 200).

## `GET /api/audit/verify`

Verifies the tamper-evident audit chain end to end. Returns
`{ ok, count, headHash, brokenAt? }`. See [audit.md](./audit.md).

## `GET /api/audit/export`

Downloadable, self-verifiable audit export: all entries in chain order with
their hashes, plus the `headHash` and the verdict. Sent as a JSON attachment.

## Auth & sharing

- `POST /api/auth/login` — `{ email, password }` → `{ token, role }` (JWT). Public.
- `GET /api/auth/me` — the caller's identity `{ email, role, authRequired }`
  (`campaign:read`).
- `POST /api/share` — mints a short-lived read token for browser links to the
  HTML/CSV report endpoints (`campaign:read`). When auth is disabled, returns
  `{ authRequired: false, token: null }`.

## Runs, exports & history

- `GET /api/runs` — list runs (optional `campaignId`). `GET /api/runs/:runId` —
  raw run. Both `campaign:read`.
- `GET /api/runs.csv`, `GET /api/runs/:runId/timeline.csv` — CSV downloads; a
  read token in `?token=` is accepted for browser opening.
- `GET /api/wrs/history` — per-target WRS history and regressions
  (`campaign:read`).
- `GET /api/reports/compare?a=<runId>&b=<runId>` — before/after HTML comparison
  of two runs. Read token accepted.
- `GET /api/reports/suite-compare?a=<suiteId>&b=<suiteId>` — before/after HTML
  comparison of two **suites** of the same playbook (the tune-and-replay loop):
  per-line WRS/verdict delta, `a` = baseline, `b` = newer replay. Read token
  accepted. See `docs/tune-and-replay.md`.
- `POST /api/reports/gap-analysis` — protection-gap analyzer (`campaign:read`).
  Body `{ profile: { <control>: 'present'|'partial'|'absent'|'unknown' }, target?
}`; returns a prioritised plan of bounded `pretest-cra-l7` lines to replay plus
  the attestation-only lines (JSON, or HTML with `?format=html`). Analytical
  only — it orders existing bounded vectors, synthesises none. See
  `docs/tune-and-replay.md`.

## Playbooks & suites

- `GET /api/playbooks` — curated + custom assessment playbooks (`campaign:read`).
- `POST /api/playbooks` / `DELETE /api/playbooks/:id` — manage **custom**
  playbooks (`campaign:create`); built-ins are immutable.
- `POST /api/playbooks/:id/instantiate` — expand a playbook into campaigns
  (`campaign:create`).
- `GET /api/suites`, `GET /api/suites/:id` — consolidated suites (campaigns
  grouped by playbook run) (`campaign:read`). `GET /api/suites/:id/report` —
  suite HTML report (read token accepted).
- `POST /api/suites/:id/run` — **Security Officer** (`campaign:approve`).
  Governed one-click sequencer: runs the suite's steps in `suiteOrder`, one at a
  time, and **advances past a step that auto-kills** so one availability loss
  doesn't strand the rest. Each pending step is approved as the caller
  (author≠approver still enforced — a step the caller authored is skipped and
  audited `suite.skip`); returns `202 { suiteId, steps, started }` and runs in
  the background (poll `GET /api/suites/:id` to watch step statuses advance).
  `409` if a sequence for that suite is already running. Audited `suite.run`.
- `GET /api/suites/sequences` — live control state of the in-flight sequences
  (`campaign:read`): `{ sequences: { [suiteId]: { paused, current, started,
total } } }`. Only sequences currently running appear.
- `POST /api/suites/:id/pause` · `/resume` · `/cancel` — **Security Officer**
  (`campaign:approve`), control a running sequence. **Pause** holds it between
  steps (the current step finishes, the next doesn't start) until **resume**.
  **Cancel** stops it and fires the kill switch on the step in flight
  (`KILLED_MANUAL`); steps not yet started are left as-is (approved/pending, not
  run). `404` when no sequence is running for that suite. Audited `suite.pause`
  / `suite.resume` / `suite.cancel`.

## `POST /api/drs-validations`

**Security Officer** (`campaign:approve`). Records a class **A/B** DRS validation
(bounded L7 assessment). Class **C** (network bench, volumetric) is rejected here
by construction — it is recorded only via the governed bench surface below. See
[drs-validation-policy.md](./drs-validation-policy.md).

## Network bench — class C (governed record-and-dispatch)

The control plane **records** CISO-authorized class-C run requests and serves
them to an **isolated external runner** (the [shieldtest-lab](https://github.com/abdelhasoloji/shieldtest-lab));
it **never executes the scenario or emits any traffic**. Dispatch is fail-closed:
disabled unless BOTH a `LAB_TARGETS` host and a `BENCH_RUNNER_TOKEN` are set.
The catalogue mirrors the zeroBS DRS Volumetric matrix (report P25-20300). See
[drs-validation-policy.md](./drs-validation-policy.md) §8.

- `GET /api/bench/scenarios` — catalogue + `{ dispatchEnabled, labTargets }`
  (`bench:read`).
- `GET /api/bench/runs`, `GET /api/bench/runs/:id` — run requests + verdicts
  (`bench:read`).
- `POST /api/bench/runs` — **CISO** (`bench:dispatch`). Body `{ scenario, labTarget? }`.
  Only a **reproducible** vector is accepted; TCP-stateful/GRE/spoofing/fragmentation
  vectors are refused (out of model). `labTarget` must be an isolated `LAB_TARGETS`
  host, never a production allowlist host. Audited `bench.request`.
- `POST /api/bench/runs/next/claim`, `POST /api/bench/runs/:id/result` — the
  **runner API**, authenticated by the `BENCH_RUNNER_TOKEN` bearer (never a user
  JWT). `claim` returns the next `REQUESTED` run (204 if none). `result` accepts
  a verdict **only while the run is `CLAIMED`** (otherwise `409`), records a
  `MEASURED_LAB` coverage row, and audits `bench.verdict`.

### Coverage & evidence

- `GET /api/bench/coverage` — coverage records per vector (`bench:read`).
- `POST /api/bench/coverage` — **CISO** (`bench:attest`). Hand-record non-run
  evidence for a vector: `INGESTED_EXTERNAL`, `ATTESTED`, `MODELLED` or `REPLAY`
  (never `MEASURED_LAB`, which only comes from a real run). Audited `bench.coverage`.
- `GET /api/bench/attestations` — structured attestation checklists (BCP38/uRPF,
  GRE-drop, fragment limits) for the out-of-model vectors (`bench:read`).
  `POST /api/bench/attestations` — **CISO** (`bench:attest`) submits a completed
  checklist; the server derives a deterministic `PASS`/`PARTIAL`/`FAIL` outcome
  and stores it as `ATTESTED` coverage.
- `POST /api/bench/coverage/import` — **CISO** (`bench:attest`). Bulk-import the
  network team's L3/4 verdicts (`{ format: 'json'|'csv', data, source? }`) as
  read-only `INGESTED_EXTERNAL` coverage; invalid rows are returned in an
  `errors` list, not dropped. Nothing is executed or emitted.

## User management

`GET/POST /api/users`, `PATCH/DELETE /api/users/:email` — **Security Officer**
(`user:manage`). Manages runtime users; env-defined users are immutable and the
allowlist can never be weakened. See [auth.md](./auth.md).

## `POST /api/notify/test`

Sends a test notification to every configured sink (`campaign:create`). `400` if
no sink is configured. See [notifications.md](./notifications.md).
