# Client-first DRS preparation interface

The current working assumption is a two-PoP qualification pilot and one independent probe. This is preparation for a measured DRS level-5 objective, not an established level-5 infrastructure capacity.

The user confirmed exactly three authorized clients: **bank.cz**, **ENISA preproduction**, and the **test VPS**. The VPS reference reuses the earlier `46.28.109.92`; ENISA's hostname is intentionally empty until supplied. Client authorization is separate from a specific URL's governed target scope. No target permission, campaign, source-IP diversity or measured score is inferred from a client record.

## Main workflow

DRS mode now opens a compact workspace with four primary destinations:

- **Overview**: objective, preparation stages, three client cards and the next infrastructure milestone.
- **Clients**: the fixed three-client register and individual scope, owner and notes.
- **Infrastructure**: first observed PoP, second site to assign and independent probe to provision.
- **Evidence archive**: existing global reports, kept distinct from client-bound evidence.

Campaigns, target administration, Fleet technical operations, Run Theater, Assistant, settings and the legacy overview remain under Technical tools. Run Theater also has a direct visible link when the application reports an active execution. Existing kill/stop behavior, capabilities and old URLs are preserved. The assistant dock does not occupy a column on the new planning pages; its full page and dock on technical pages remain available.

## Client records and boundaries

`GET /api/workspace/clients` returns only `bank-cz`, `enisa-preprod`, and `test-vps`, with client status `authorized`, a separate target-scope annotation and null measured score. Initial entries are returned without mutating storage. No fourth client can be created through the API; the fixed identities cannot be renamed.

Administrators can edit metadata through `PUT /api/workspace/clients/:id` with `{expectedRevision, profile}`. Readers can inspect it. Each save appends a schema-versioned client revision and an atomic actor-bound audit record. Concurrent stale saves return 409 and retain the UI draft. `GET /api/workspace/clients/:id/history` exposes its revision history.

Migration 10 extends the existing infrastructure revision table's kind constraint to include client metadata. It does not rewrite accounts, targets, campaigns, previous evidence or infrastructure history. The existing encrypted full-database recovery comparison includes client rows because it checks all revision kinds.

This increment does not bind historical reports to a client by guessing from a hostname. Client detail shows evidence as unbound until a proper association exists. The global archive is explicitly global. It also does not deploy the prototype, move workers or change any traffic limits.

## Infrastructure presentation

The first PoP uses only the API's dated ac02 preparation checkpoint, including x86_64/KVM and an unknown observed Ready count. The second PoP and external probe remain unassigned. A read failure keeps deployment state unknown. Full inventory, attestations and artifact provenance sit inside the technical details rather than dominating the main page.

The earlier interface remains available for legacy mode and via `/overview-legacy`. Source changes are not a production deployment; follow the release procedure and verify served API/UI identity before claiming delivery.
