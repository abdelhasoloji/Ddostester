# Audit integrity (tamper-evident chain)

Every audit entry (creation, approval, rejection, execution, kill, user and
playbook changes) is linked into a **hash chain** so the log is verifiable and
any alteration is detectable. This is measurement/governance only — it generates
no traffic and changes no security boundary.

## How it works

At write time the store computes, for each entry:

- `prevHash` — the `hash` of the previous entry (or `GENESIS` for the first);
- `hash` — `SHA-256(prevHash + "\n" + canonical(entry))`, where `canonical`
  commits to the immutable fields `[id, at, actor, action, campaignId, detail]`.

Appends are serialized (a Postgres advisory lock; single-threaded in memory) so
the chain never forks. The logic is a pure module,
[`backend/src/modules/audit/integrity.ts`](../backend/src/modules/audit/integrity.ts),
covered by property-based tests (any field mutation, reorder, or interior
deletion is detected).

## Verifying

`verifyChain` walks the entries in write order and reports:

- **content** break — a field was changed (its stored `hash` no longer matches);
- **link** break — an entry no longer chains onto its predecessor (reorder or
  interior deletion);
- **missing-hash** — an entry predating the chain, or stripped of its hash.

The first _retained_ entry's `prevHash` is accepted as an anchor, so **retention
pruning** of the oldest entries does not read as tampering. Truncation of the
**newest** entries is caught only against a previously exported `headHash`, which
is why the export includes it.

## Endpoints

| Method | Path                | Role          | Returns                                                    |
| ------ | ------------------- | ------------- | ---------------------------------------------------------- |
| GET    | `/api/audit/verify` | campaign:read | `{ ok, count, headHash, brokenAt? }`                       |
| GET    | `/api/audit/export` | campaign:read | Downloadable JSON: entries + hashes + `headHash` + verdict |

In the UI, **Audit log → Verify integrity** shows the verdict badge and
**Export (JSON)** downloads the self-verifiable document.

## Retention

`pruneOldData` still deletes entries older than the retention window; the
retained tail stays verifiable via the anchor rule above.
