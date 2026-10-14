# Unique administrator and account management

`USER_MODE=single` is the default personal/lab workflow. The persisted owner is selected
initially using `SINGLE_USER_EMAIL` (default `abdelha@wedos`). The owner is the only admin.
Other accounts retain their profiles and active/disabled status; they are visible and manageable
in Users & access. Previously disabled accounts are never silently reactivated.

Admin has every application capability in both single and team workflows. Engineer prepares
and launches approved campaigns, CISO validates, viewer consults. `/api/auth/me` returns
`capabilities`, `contractVersion: 1`, `primaryAdminEmail`, `userMode` and `approvalPolicy`.
The frontend uses these capabilities; there is no separate client role matrix.

In single workflow, the administrator explicitly confirms target/rate/concurrency/duration
before each campaign or whole assessment. The API requires `{ "confirmed": true }` on launch.
Other profiles retain the governed approval workflow. `USER_MODE=team` also imposes separation
of duties on admin; full permissions do not bypass that workflow. `REQUIRE_CISO_APPROVAL=1`
requires team mode. The scheduler and share-token creation remain off in single mode.

## Explicit migration

PostgreSQL, a signing secret of at least 32 characters and the selected account are required.
No account mutation happens on an ordinary application startup. Before the first new-version
startup, stop the old API, back up PostgreSQL and the runtime environment, build the new code,
then run the migration using the same protected environment as the service:

```bash
node backend/dist/cli/migrate-users.js          # preview, emails/roles/status only
node backend/dist/cli/migrate-users.js --apply  # explicit atomic migration
```

In Compose, after building the image and starting PostgreSQL, use a one-shot API container
with its normal environment:

```bash
docker compose run --rm api node backend/dist/cli/migrate-users.js --apply
```

The migration imports AUTH_USERS into PostgreSQL once, with stored credentials taking
precedence on collisions. The selected owner becomes active admin; other administrators
become viewers. Other statuses, password hashes, historical authors, campaigns and reports
are preserved. It writes the policy version and audit in the same transaction as account
changes. Old env-root sessions are invalidated through token versions; ordinary restarts and
migration retries never reset passwords or token versions. Remove obsolete AUTH_USERS from
the runtime configuration after verifying the imported accounts.

On an empty installation only, the explicit migration can create the owner using
SINGLE_USER_PASSWORD, which must satisfy the existing password policy. Keep this bootstrap
secret out of Git and command arguments; remove it from configuration after migration.
The migration refuses an unknown selected account in an existing installation. A persisted
owner is not transferable through ordinary routes or by changing an env variable. Recovery
requires stopping the API and using the protected deployment backup or an explicit operator
procedure; it must preserve the one-owner invariant and audit the action.

## Account operations and sessions

Users & access supports non-admin creation, profile changes, disable/reactivate, temporary
password reset, account removal and session revocation. Creation of a second administrator,
owner demotion/deactivation/removal and ordinary self-modification are rejected server-side.
My account supports self-service password change and “Revoke other sessions”, which rotates
the current token and revokes earlier tokens. Logout revokes the user's current token version.
Revocation operates on all tokens for a user; per-device session listings are not implemented.

All managed account mutations are serialized in database transactions with audit appends;
role/status/password changes increment the token version. Reports and SSE validate current
account state/version. A 401 clears both the stored token and the React identity.
Legacy team installations without a migrated policy still support env-root accounts; migrate
explicitly to use the unified persisted lifecycle. The deployed installation uses that policy.

Operational caps remain editable beneath the unchanged immutable ceiling: 2,000 RPS,
500 concurrent requests, 900 seconds. Allowlist, attestation, confirmation/approval,
kill switch and audit remain enforced. Tests of authorization use a mocked runner. No real
campaign on current VPS targets is needed to validate this deployment.

## Release validation and rollback

Deploy one matching backend/UI release, with a stamp identifying the tested source snapshot.
Verify /ready, /health accessContractVersion, /api/auth/me capabilities and primary owner,
user listing, viewer refusals and actual served UI assets. A health 200 alone is insufficient.
Keep the old service definition, environment, database backup and release until acceptance.
For rollback stop the API, restore the previous service release and environment, and restore
account policy/roles from the protected backup if the migration needs reversal. Never reset
passwords or discard campaign/report/audit data merely to roll back a UI release.
