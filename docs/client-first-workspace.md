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

Historical reports are not bound to a client by guessing from a hostname. New offline prototype campaigns carry a server-captured client scope snapshot, while measured evidence remains unbound. The global archive is explicitly global. It also does not deploy the prototype, move workers or change any traffic limits.

## Infrastructure presentation

The first PoP uses only the API's dated ac02 preparation checkpoint, including x86_64/KVM and an unknown observed Ready count. The second PoP and external probe remain unassigned. A read failure keeps deployment state unknown. Full inventory, attestations and artifact provenance sit inside the technical details rather than dominating the main page.

The earlier interface remains available for legacy mode and via `/overview-legacy`. Source changes are not a production deployment; follow the release procedure and verify served API/UI identity before claiming delivery.

## Deployment checkpoint

Build 475 was verified deployed on 15 October 2026 at 22:09 UTC, from commit `5d316ed70d493a239d4e844300bd17fb0dd4d54f`. See the [sanitized deployment receipt](client-workspace-deployment-checkpoint.json) and [current setup](current-setup.md). The passive PoP prototype remains staged, not applied.

## Testable application prototype

Open **Clients → a client → New prototype campaign**, then **Freeze prototype plan → confirm simulation → Run simulated assessment → Generate final report**. The embedded Run Theater shows persisted state, proof count and a compact progression; the complete timestamped journal is expandable. Choose healthy service, service outage, generator saturation or missing telemetry before simulation. The target level is 5; unresolved reference conditions may still produce a partial or indeterminate simulation report.

Campaigns and reports remain available through the saved selector and `?prototype=<campaign-id>` after a reload. JSON download includes the frozen plan, evidence, interpretation reservations and client snapshot. These are virtual engine events, with no physical agents, target authorization or network traffic. Client cards retain **Not evaluated** for measured resilience.

`POST /api/drs/validations` optionally accepts `clientId` from the fixed three-client register. The server captures the current client revision, hash and profile inside the campaign transaction and audits its association digest. Caller-supplied scope cannot replace that snapshot. GET assessment and JSON/HTML reports return this context. Unknown client IDs are rejected before storage. No migration is needed: campaign JSON already stores the association. Existing unbound validations remain supported.

This prototype is verified deployed as build 478. See the [prototype deployment receipt](client-prototype-deployment-checkpoint.json). The earlier build-475 checkpoint describes the initial planning interface.

### Concise guidance

Keep primary screens focused on actions, state and results. Contextual `ⓘ` help opens on hover, keyboard focus or touch; Escape or loss of focus closes it. Technical journals and reservations remain collapsed. The simulation label, confirmation and result status stay visible. Mobile help is pinned inside the viewport.

## Client evidence archive increment

Evidence archive now includes a separate client-assessment table, filtered to explicit client-bound engine validations. Filter by one of the three authorized clients; open a finalized report or resume an active prototype. Archived prototypes remain visible and their assessment controls are read only. Unbound historical campaigns and physical runs are not guessed into a client. The table loads its own current campaign snapshot, exposes refresh and distinguishes load failures from an empty archive. Physical run reports and technical exports remain in a collapsed section in DRS mode; the assistant dock is hidden on this primary archive page. On mobile, date and simulation mode sit below the client name so the report action remains visible.

Finalized prototypes support both JSON evidence and a standalone HTML report. HTML is fetched with the session Authorization header and downloaded as a file; no write token is added to a URL. Non-HTML responses and expired sessions are rejected. Creation navigates to the returned campaign immediately, independently of list refresh. This source increment requires a separate verified release; build 478 remains the preceding deployed checkpoint.
