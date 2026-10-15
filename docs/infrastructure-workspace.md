# Infrastructure study workspace

This source increment adds **Fleet → Infrastructure readiness → Open infrastructure workspace**. Loading is explicit; the workspace does not poll, connect to hosts, deploy workloads or emit traffic. It is separate from IoT device enrollment and campaign execution.

## Inventory

An administrator records each physical host with a stable ID and site, architecture, OS, runtime, CPU, memory, NIC, declared link speed, management/data interfaces, VPN address, allocated public addresses and observed egress addresses. Unknown quantities remain `null` or empty lists. No RL300 is automatically created from the declared estate. Declared link speed is not usable or measured throughput. Address entries are syntax-checked metadata; their ownership and routing are not verified by recording them.

Changing a host appends a new revision with schema version, actor, time, previous hash and SHA-256 over canonical content. `expectedRevision` prevents concurrent operators from overwriting each other. Existing devices, credentials, accounts, settings and campaigns are not rewritten. There is no destructive inventory delete in this increment.

PostgreSQL migration 9 adds only `infrastructure_revisions_v1`. Memory fixtures provide the same contract. Revision and actor-bound audit append commit atomically. Host history is retained; evidence submissions are separate immutable records, including failures. Storage envelopes live in `INFRASTRUCTURE_LIMITS`; campaign/Fleet traffic ceilings are unchanged.

## Two-host preparation

Select at most two distinct host records. Each has eight evidence gates: architecture, runtime, NIC, management, data egress, clock, independent probe and stop receipt.

The operator supplies a timestamp, outcome and sanitized receipt text. The server hashes the complete record and binds it to the current host revision. No evidence URL is fetched and no command is executed. Do not paste passwords, tokens, private keys or protected environment files.

Gate statuses:

- `missing`: no relevant submission.
- `stale-profile`: submissions exist, but none binds the current host revision.
- `expired`: the latest matching observation is older than seven days.
- `unknown` / `fail`: the newest observation has that outcome.
- `conflicting`: observations at the same latest observation time disagree.
- `attested`: a fresh matching operator submission reports pass.

The newest observation time takes precedence over submission time, so a late upload of an old pass cannot supersede a newer failure. All submissions remain visible. A host becomes `documented` only when every gate is attested; the pair becomes documented only with two documented hosts. **This remains an operator evidence register, not independent qualification.** `hardwareQualified` and `executionAuthorized` are always false. Nothing in this workspace unlocks a campaign or increases capacity.

Updating a host invalidates the applicability of previous receipts without erasing them. A documented profile is not a DRS verdict, hardware certification or authorization to run a test.

## DRS readiness and baseline diagnostics

The read-only readiness table derives levels 1–5 and vector/source/page references from the pinned DRS catalogue. It distinguishes bounded HTTP approximations from reference-only entries and displays full physical qualification as not established. It never computes a capacity figure, multiplies sources or awards a measured score from this inventory. Campaign evidence and scoring remain in the existing assessment engine.

A campaign's DRS report now presents retained baseline-refusal diagnostics: reason, duration, reported/retained sample counts, availability, mean, stored CV/tolerance, latency min/p50/p95/max and raw samples. Percentiles use nearest rank over valid retained values; invalid or missing values are flagged. No outlier is removed from the archived record. Collector clock and independent vantage are explicitly unrecorded in this legacy diagnostic. No capture cadence, frozen threshold or verdict changes, and no failed campaign is retried by opening this view.

## API

All paths are under `/api/fleet/infrastructure`:

| Method and path          | Contract                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                  | Latest hosts, all evidence, qualification summary, storage limits and level-5 readiness. `?hosts=host-a,host-b` chooses the pair. |
| `PUT /hosts/:id`         | Admin: `{expectedRevision, profile}`. Creation expects 0; conflicts return 409.                                                   |
| `POST /evidence`         | Admin: `{hostId, profileHash, gate, observedAt, outcome, content}`. Stale bindings return 409.                                    |
| `GET /:kind/:id/history` | Append-only revisions for `host` or `evidence`.                                                                                   |

Reads use `campaign:read`; writes use `user:manage`, matching the Fleet inventory policy. Existing server capability checks remain authoritative. The UI hides mutation controls from readers and clears stale readiness after a failed refresh. The explicit refresh button permits recovery without a retry loop.

## Remaining infrastructure inputs

Martin still needs to provide the actual host/OS/runtime/NIC/interface inventory, VPN access and routing details, address allocation and independently observed egress. The [two-host preparation dossier](rl300-two-host-preparation.json) records these as pending. This increment does not contain a new distributed traffic engine or deployment configuration.

Local verification is distinct from production delivery. Migration and UI changes are in source only until an explicitly identified release is promoted through the existing [operations process](operations.md). The previous production checkpoint remains unchanged by local tests.

## Local delivery evidence

The [checkpoint](infrastructure-workspace-checkpoint.json) pins the tested application/image source and verification outcomes. The PostgreSQL CI selection includes `test/infrastructure.test.ts`; the authenticated recovery gate additionally compares every infrastructure revision and evidence row after restoring the encrypted archive into a separate disposable database. An archive authentication failure is still rejected before database access. None of these local checks promotes a production release.
