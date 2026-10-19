# Pre-step review and parameter editing — 18 October 2026

Source increment on the classic ZeroBS branch; not a production deployment. The browser starts legacy HTTP suites with `pauseBetweenSteps: true`. The first step starts after normal suite confirmation; each subsequent runnable step waits for an operator. Pause-after-current and Resume-next are now directly available in Run Theater. Direct API callers retain automatic sequencing unless they explicitly enable the option.

Unstarted classic campaigns expose a Parameters dialog in campaign cards and the suite stepper. Editable budgets are integer rate, concurrency and duration; existing scenario phases expose their rate and duration, with server validation of peak and total. Targets, protocols, engines, flows, assertions, stop rules and phase count are preserved. Historical/completed runs and frozen DRS/Fleet documents are not rewritten; those plans retain their revision workflows.

## Guarantees

- Bounds are current operational limits clamped to immutable ceilings, read from the server. Built-in routing thresholds are explanatory hints, not a claimed hardware maximum. No ceiling was raised.
- An active sequence must be paused with no current step, recovery gate or concurrent editor before a save. Standalone in-flight work and historical records cannot be edited.
- A saved budget becomes pending approval. Previous approval and CISO co-signature are cleared; the editor becomes the author responsible for renewed approval. Original authoring events remain in the audit. Parameter state and before/after audit are transactional.
- A revision digest refuses stale edits; the run path rejects concurrent editing. At resume, the sequencer reloads the actual stored step rather than using its initial snapshot.
- Team mode requires renewed approval. Single-owner mode requires explicit confirmation of the modified budgets; reviewed budget values must match the server or resumption is rejected. Cancellation is not converted into an approval.
- Pause does not stop the current generator. Kill and Cancel retain their existing roles. A pause during recovery is checked again before dispatch.
- A focused queued step in a paused suite no longer renders a false baseline-capture/kill panel.

## Verification

`campaign-parameters.test.ts` covers bounds, preserved targets and phases, stale writes, historical/frozen rejection, transactional audit rollback, permissions, automatic inter-step pause, renewed team approval, use of the edited next-step values, and explicit single-owner confirmation including a stale confirmed budget. Execution is mocked and emits no traffic. Existing sequencer/recovery/auto-pause tests check compatibility. The final focused gate passed 42 backend and 31 frontend tests, type checking, lint and production build. The mandatory push gate separately runs the full test suites. Frontend tests cover server bounds, save revision, history locks and the focused paused-suite regression.

`ui-fixture.mjs` is a local presentation-only fixture: its paused sequence state is illustrative, generation/approval/resume endpoints are refused, and the real parameter-save route is available only for its in-memory next step. Browser verification opened the dialog, saved 5→4 req/s, reopened it to verify persistence and checked aligned desktop fields, an unclipped tooltip and a 390-pixel viewport. The screenshots are UI evidence, not an executed campaign or production acceptance. The old build label identifies the fixture base, not an immutable new release.

Files: `parameters-desktop.png`, `parameters-tooltip.png`, `parameters-mobile.png`. The local server is stopped after acceptance; no external campaign or deployment is performed by this increment.
