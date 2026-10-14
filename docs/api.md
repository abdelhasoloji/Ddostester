# API reference

Base: `http://127.0.0.1:8080` (via SSH tunnel). JSON responses, except the report
(HTML). No traffic is emitted toward a target outside `ALLOWED_TARGETS`.

## `GET /health`

Service status, the running build stamp, and allowed targets. `version` is the
commit THIS API process serves (`{version, build, commit, builtAt}`) — use it to
confirm a deploy actually landed, independently of the UI bundle's own footer.

```bash
curl -s localhost:8080/health
# {"status":"ok","version":{"version":"0.1.0","build":"176","commit":"2a39232"},"allowedTargets":["127.0.0.1","localhost"]}
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

## `POST /api/campaigns/:id/ciso-approval`

Mandatory **CISO sign-off** (dual control), CISO role only
(`campaign:ciso-approve`). Co-signs an officer-approved campaign; separation of
duties is enforced (`ciso ≠ author`, `ciso ≠ officer approver`). Only meaningful
when the deployment sets `REQUIRE_CISO_APPROVAL=1` (advertised by `/health` as
`requireCisoApproval`): a campaign is then executable only after BOTH the officer
approval and this sign-off — enforced server-side so neither the execute endpoint
nor the suite sequencer can bypass it. Audited `campaign.ciso_approve`.

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
via the HttpOnly read cookie (EventSource). Session JWTs in URLs are refused.

## `POST /api/campaigns/:id/kill`

Manual kill switch (level 2) of a running campaign.

```bash
curl -s -X POST localhost:8080/api/campaigns/<id>/kill
# {"status":"KILLED_MANUAL"}
```

## `POST /api/campaigns/:id/cancel`

Cancels an **unrun** campaign — `PENDING_APPROVAL` or `APPROVED` — before it
executes, moving it to the terminal **`CANCELLED`** state (distinct from
`REJECTED`, an approval decision, and the `KILLED_*` run outcomes). Optional
`{ reason }`. `400` for a running or already-terminal campaign (use the kill
switch for a run in flight); `404` if not found. **Security Officer**
(`campaign:approve`). Audited `campaign.cancel`.

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
query (ISO). Browser opening uses the HttpOnly read cookie; session JWTs in query parameters are refused.

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
`{ ok, count, headHash, brokenAt? }`. See [security-and-governance.md](./security-and-governance.md).

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
  browser reads use an HttpOnly cookie; only team share grants may use `?token=`.
- `GET /api/wrs/history` — per-target WRS history and regressions
  (`campaign:read`).
- `GET /api/reports/compare?a=<runId>&b=<runId>` — before/after HTML comparison
  of two runs. Read token accepted.
- `GET /api/reports/suite-compare?a=<suiteId>&b=<suiteId>` — before/after HTML
  comparison of two **suites** of the same playbook (the tune-and-replay loop):
  per-line WRS/verdict delta, `a` = baseline, `b` = newer replay. Read token
  accepted. See `docs/measurement.md`.
- `POST /api/reports/gap-analysis` — protection-gap analyzer (`campaign:read`).
  Body `{ profile: { <control>: 'present'|'partial'|'absent'|'unknown' }, target?
}`; returns a prioritised plan of bounded `pretest-cra-l7` lines to replay plus
  the attestation-only lines (JSON, or HTML with `?format=html`). Analytical
  only — it orders existing bounded vectors, synthesises none. See
  `docs/measurement.md`.

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
[boundary-and-lab.md](./boundary-and-lab.md).

## Network bench — class C (governed record-and-dispatch)

The control plane **records** CISO-authorized class-C run requests and serves
them to an **isolated external runner** (the [shieldtest-lab](https://github.com/abdelhasoloji/shieldtest-lab));
it **never executes the scenario or emits any traffic**. Dispatch is fail-closed:
disabled unless BOTH a `LAB_TARGETS` host and a `BENCH_RUNNER_TOKEN` are set.
The catalogue mirrors the DRS Volumetric matrix (report P25-20300). See
[boundary-and-lab.md](./boundary-and-lab.md) §8.

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

`GET/POST /api/users`, `PATCH/DELETE /api/users/:email` — **Administrator**
(`user:manage`, in both single and team modes). `POST` creates a stored account
with a temporary password; `PATCH` accepts `role` and/or `status` (`active` or
`disabled`). Role/status changes revoke existing sessions through tokenVersion.
`POST /api/users/:email/password` resets a temporary password and revokes sessions;
`POST /api/users/:email/sessions/revoke` revokes another stored account's sessions.
Mutations and audit entries share a transaction. The persisted owner remains the
sole admin and cannot be deleted, disabled or demoted by these routes. Environment
accounts must be imported before mutation. Target allowlists remain separately
enforced. See [security-and-governance.md](./security-and-governance.md) and
[owner recovery](./owner-recovery.md).

## `POST /api/notify/test`

Sends a test notification to every configured sink (`campaign:create`). `400` if
no sink is configured. See [observability.md](./observability.md).

## Legacy generator fields and fleet evidence

`originRps` is a compatibility field for successful generator responses per second.
It does not measure traffic received by the origin. `absorbedRatio` and
`absorbedPct` are the generator failure fraction and its percentage, respectively;
they do not prove mitigation, rejection at the edge or a tarpit. New integrations
should use explicit successful-response and failure labels, and corroborated
receiver telemetry for target arrival. Historical JSON fields remain readable;
there is no removal date or silent score recalculation.

`GET /api/runs/:runId/fleet-evidence.json` exports a recorded campaign report.
`GET /api/fleet/runs/:runId/evidence.json` and
`GET /api/fleet/campaigns/:campaignId/evidence.json` export durable coordination
snapshots, including when no finalized campaign report survived a control crash.
All require `campaign:read` and return `Cache-Control: no-store`. The durable
snapshot identifies itself as `isFinalizedCampaignReport=false`; missing probe,
baseline, receiver receipts and WRS are not reconstructed. SHA-256 detects content
alteration, without authenticating the exporter.

For new plans, durable counter coverage uses the original persisted fleet size.
Legacy plans without that field return `expectedAgents=null`; surviving shard rows
do not establish original coverage. This additive migration is implemented in the
current sources and must run through coordinator initialization before those
sources are promoted. Linux source-06 has this migration and returns null for
legacy plans; source-05 historical exports retain their earlier calculation.

## Authenticated session lifetime

New login/password-rotation/self-revocation session JWTs default to one hour.
Writes require Bearer authentication. The HttpOnly read cookie uses the remaining
signed JWT lifetime and never extends it when `/api/auth/me` is called. At expiry,
the client must authenticate again; no refresh token is issued. Existing signed
sessions remain valid until their original expiry or explicit version revocation.
Separately governed read-only share tokens retain their requested TTL. This
policy is verified on the private Linux source-06 API; production build 451
remains unchanged.

## Remote baseline observation coverage

New remote baselines record `observation` with vantage, expected/received/missing
sample counts and completeness. `samples` and numeric availability remain compatible
with existing readers; when observation coverage is incomplete, those numeric
fields do not establish target availability. The UI shows unknown, comparison
deltas and baseline drift notifications are withheld, and measurement confidence
is degraded. An automatic safety stop still occurs under its original policy, but
an incomplete remote baseline prevents attributing that stop to a proven target
outage. Historical baseline records without this metadata remain readable; stored
scores and assessments are not silently rewritten. This is available in the private Linux source-06 image; its full phase/fleet
recipe remains pending.

Remote baseline `quality` now uses the same summary as live probe diagnostics:
measured/total samples, known event-loop coverage, per-measurement and recent-window
peaks, throttled fraction and latest process sample. Baseline and load remain separate
phases; their overlapping process windows are not independent costs. Missing or
contended baseline diagnostics degrade confidence and suppress baseline comparisons
and drift attribution. HTML, CSV and the detail panel expose baseline diagnostic
fields separately. Historical baselines without this optional field remain readable.
This is deployed in the private Linux source-06 image; complete real phase
validation remains pending.

## Recovery gate provenance

For remote recovery, `available` describes observed reachability; `verified`
also requires complete responses and sufficient non-contended resource diagnostics.
The suite refuses to advance on `verified=false`, retains the gate snapshot in its
audit, and pauses after repeated unavailable or unverified gates. A passed gate is
stored as `recoveryBeforeRun` on the following suite step, exposed in its detail,
HTML/CSV and fleet evidence. This is a before-step observation, not a measurement
of recovery after that run. Legacy/local recovery records keep their existing
reachability contract. Waiting uses monotonic elapsed time and clips each request
and polling sleep to the remaining gate budget. These changes are present in the private Linux source-06 image; full suite
recovery validation on that image remains pending.

## Fleet startup diagnostics

New fleet summaries record `startup` (`ddostester.fleet.startup/v1`) with per-agent
start delays relative to the parent, coverage and first/last known delay. Only
coherent generator start/finish timestamps within the parent window are included;
missing or incompatible clocks are unknown. These are generator timestamps, not
first request arrivals at the target. The global `actualRps` retains its complete
parent-window denominator, including deployment/startup; per-agent active-window
rates are not substituted for it. A backwards parent clock rejects aggregation
instead of creating an inflated rate. UI/HTML/CSV/evidence export keep startup
cost separate from the measured global rate. This addition is source-only; Linux
source-06 records retain their original fields and scoring.
