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
`{sent, successful, failed, elapsedSec, actualRps, maxDurationSec, status}` ~1×/s,
then `{status:"done"}`. Token via `?token=` (EventSource).

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

## `GET /api/audit`

Audit log (read). `limit` query (default 200).

## `GET /api/audit/verify`

Verifies the tamper-evident audit chain end to end. Returns
`{ ok, count, headHash, brokenAt? }`. See [audit.md](./audit.md).

## `GET /api/audit/export`

Downloadable, self-verifiable audit export: all entries in chain order with
their hashes, plus the `headHash` and the verdict. Sent as a JSON attachment.
