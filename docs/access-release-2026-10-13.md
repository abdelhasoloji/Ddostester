# User management release — 13 October 2026

Deployed source snapshot: `d98db08+access.64ac10dfbc0e`, build 450.
This identifies a tested working-tree snapshot, not a new Git commit or a pushed branch.

## Deployment

- Active release: `/home/shieldtest/ddostester-releases/access-64ac10dfbc0e`.
- Service drop-in: `/etc/systemd/system/ddostester.service.d/30-access-release.conf`.
- Protected backup: `/root/ddostester-release-backups/access-64ac10dfbc0e`.
- The backup includes PostgreSQL dump, runtime environment and previous service definition.
- The original VPS Git checkout was preserved. Matching API/UI artifacts were promoted together.
- Dependencies were copied as a hard-link snapshot from the existing, matching package lock.

The service now runs from the isolated release directory. Future promotions must explicitly
switch the service release and verify its build stamp; the legacy checkout's update script
alone does not switch this drop-in. Do not treat an HTTP 200 as proof that a newly built
checkout is serving requests. Retain the protected backup for rollback.

## Account migration

The explicit migration persisted account policy v1 with `abdelha@wedos` as the only admin.
The three env-defined accounts were imported; all 11 accounts are now managed in PostgreSQL.
Existing password hashes and account statuses were compared before/after and preserved.
AUTH_USERS and bootstrap password overrides were removed from the active envfile after
migration. Scheduler remains off. Other profiles retain their permissions and are manageable.

## Validation

- Full gate passed: lint, typecheck, 930 backend tests, 391 frontend tests, backend/UI builds.
  Thirteen conditional tests were skipped.
- Actual PostgreSQL transaction/audit rollback verified on the VPS before migration.
- Unique owner, account listing, API capability contract and viewer refusal verified.
- `/health` reports the expected source snapshot, access contract v1 and single_admin policy.
- Authenticated headless browser verified Users & access, profile controls, session revocation
  controls and campaign creation access using the served UI and API.
- No campaign or load generator launched on the VPS as part of release validation.

Sessions are revoked per user through token-version rotation; per-device session listings
remain future work. The ordinary startup verifies persisted ownership without modifying
accounts. The owner password is unchanged; reload the browser to fetch the new interface.
