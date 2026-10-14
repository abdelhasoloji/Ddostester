# Persistence

`backend/src/store/types.ts` defines the store contract; PostgreSQL implements durable application records and ordered transactional migrations. Audit and guarded mutations must commit together. Default single mode requires persistent account policy; legacy team-mode memory fixtures are not the deployed model.

DRS revisions, attempts, reports, evidence receipts and hash-chain history preserve failed and incomplete tests. Storage envelopes in `config/limits.ts` are not traffic budgets. Archive integrity checks fail closed; a structurally valid import is not physical attestation.

Use disposable PostgreSQL test/restore databases for verification. Preserve existing account/password/status policy, campaigns, results and audit before upgrades. See [account migration](../single-user.md), [operations](../operations.md), [testing](../testing.md) and [current setup](../current-setup.md).
