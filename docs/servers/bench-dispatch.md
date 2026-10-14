# Synthetic bench dispatch

`backend/src/modules/bench/` records authorized named laboratory scenarios and artifacts. The companion lab runner claims through `/api/bench/runs/next/claim` and posts `/api/bench/runs/:id/result` using its dedicated runner token. It receives registered scenario names and lab labels, not arbitrary public target/rate commands.

Historical scenario-level labels are legacy diagnostic mappings, not the official 131-row DRS catalogue or proof that a vector passed. The current catalogue and scorer live in `modules/drs/` and the pinned standard directory. Bench attachments remain diagnostic.

See the [mirror contract](../cross-repo-contract.md), [DRS engine](../drs-engine.md) and [current source observations](../current-setup.md). Configured dispatch/provider flags do not establish an active or qualified physical scenario.
