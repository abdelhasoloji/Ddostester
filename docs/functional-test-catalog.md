# Functional test catalog (UI journeys, expected results, gap verdicts)

This is a test/reference artifact, not today’s deployment or physical DRS qualification. Use [current verification](testing.md) and workspace configuration for current gates. Historical result counts do not replace a fresh run.

A broad-spectrum functional catalog for the ShieldTest interface. Each row is a
user journey deduced from the app's real behaviour, an **expected result**, and a
**verdict** written to be self-critical:

- ✅ **conforms** — expected behaviour is implemented (verified in code).
- ⚠️ **gap (UX/coherence)** — works, but the journey is confusing or inconsistent.
- 🔴 **gap (missing)** — the expected result is not delivered.
- ❓ **verify at runtime** — plausible from code, must be confirmed in a browser.

Verdicts marked from code review are noted as such; ❓ items are the ones an E2E
run would settle. This catalog is the source list for the Playwright specs.

**Status:** the auto-kill explanation gap (D4/D6/E3/J3) is **fixed** — runs now
persist and render a `statusDetail`. A Playwright suite (`e2e/`) covers the auth,
RBAC, navigation and full-lifecycle journeys below (13 specs, green). Rows
implemented there are marked ✅ (e2e).

**Executable catalog (data-driven).** Beyond this hand-written journey list, a
combinatorial catalog crosses roles × routes × inputs × states as executable
cases: **`backend/test/catalog/`** runs **367 cases** against a real Fastify
instance (`app.inject`), each with an expected result argued against
**`docs/test-catalog/specification.md`** (numbered SPEC-\* rules). Run it with
`npm test -w backend`; the run writes **`docs/test-catalog/results.md`** (counts,
per-area table, findings, full case list). Current run: **304 passed, 0 failed,
0 findings** — the three findings from the first pass have been **fixed**:

- **SoD extended** — the officer who approves a campaign may no longer also
  execute it (approver ≠ executor now enforced at the API and hidden in the UI);
- **`POST /api/users` is create-only** — re-creating an existing user is a `409`,
  no silent overwrite (role changes go through `PATCH`);
- **caps are integers** — fractional `maxRps`/`concurrency`/`maxDurationSec` are
  rejected.

Roles: **engineer** (create/execute/kill, not approve), **officer**
(everything + approve + user:manage), **viewer** (read + kill).

---

## A. Authentication & session

| ID  | Journey                                | Expected result                                                         | Verdict                                     |
| --- | -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| A1  | Load `/` with auth enabled             | Login screen ("Sign in") renders; app shell hidden                      | ✅ (e2e)                                    |
| A2  | Login with valid officer credentials   | Redirect to shell; nav shows all sections the role allows               | ✅ (e2e)                                    |
| A3  | Login with wrong password              | Inline "invalid credentials"; no token stored; stays on login           | ✅ (e2e)                                    |
| A4  | 5 failed logins in a row               | Account locked ~60 s; further attempts rejected with a lock message     | ❓ (backend has lock; UI copy?)             |
| A5  | Refresh the page after login           | Session persists (token in storage); no re-login                        | ❓                                          |
| A6  | Logout                                 | Token cleared; back to login; protected views no longer reachable       | ❓                                          |
| A7  | Deep-link `/campaigns` via URL refresh | SPA fallback serves index; route renders (not a 404)                    | ✅ (server fallback excludes /api,/metrics) |
| A8  | Token expired / tampered               | Next API call → 401; UI returns to login with a clear message           | ❓                                          |
| A9  | Auth **disabled** (no AUTH_JWT_SECRET) | No login screen; `/health` shows `authRequired:false`; all actions open | ✅                                          |

---

## B. Campaign creation (form, validation, safeguards)

| ID  | Journey                                                 | Expected result                                                             | Verdict                                          |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| B1  | Officer/engineer opens "New campaign"                   | Form visible; viewer sees no create button                                  | ✅ (RBAC)                                        |
| B2  | Submit without the authorization attestation            | Rejected: "must be attested as authorized"                                  | ✅ (backend) — ❓ shown inline in UI             |
| B3  | Target host **not** in the allowlist                    | Rejected: "host ... is not in the allowlist"; no run created                | ✅ (backend) — ❓ surfaced pre-submit vs after   |
| B4  | Probe URL not in the allowlist                          | Same rejection for the probe field                                          | ✅ (backend)                                     |
| B5  | Non-http(s) target (e.g. `ftp://`)                      | Rejected: "only http/https are supported"                                   | ✅ (backend)                                     |
| B6  | `maxRps` above HARD_CAPS (2000)                         | Rejected with the cap stated; **and** the form should block it client-side  | ⚠️ verify client caps == server caps (coherence) |
| B7  | `durationSec` above HARD_CAPS (900)                     | Rejected with the cap                                                       | ⚠️ same client/server coherence check            |
| B8  | `concurrency` above cap (500)                           | Rejected                                                                    | ⚠️ same                                          |
| B9  | Empty name / empty author                               | Rejected: name required / author required                                   | ✅ (backend) — ❓ field-level UI error           |
| B10 | Start from a preset                                     | Fields pre-filled with a valid, in-caps configuration                       | ❓                                               |
| B11 | Pick an engine that is "not installed"                  | UI marks it; run falls back to builtin (labelled "not installed → default") | ✅ (copy exists)                                 |
| B12 | Create a multi-step flow with an off-allowlist step URL | Rejected: "Flow step: host ... not in the allowlist"                        | ✅ (backend)                                     |
| B13 | Successful creation                                     | Campaign appears with status PENDING_APPROVAL in Campaigns                  | ❓ (cross-page A→)                               |

---

## C. Approval & separation of duties

| ID  | Journey                                             | Expected result                                     | Verdict                                                  |
| --- | --------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| C1  | Engineer tries to approve                           | No approve action (engineer lacks campaign:approve) | ✅ (RBAC)                                                |
| C2  | Officer approves a campaign they did **not** author | Approved; status moves to APPROVED/ready            | ✅ (SoD)                                                 |
| C3  | Officer approves a campaign they **authored**       | Blocked: approver ≠ author (separation of duties)   | ✅ (approver=author disabled in UI: ui.tsx sameAsAuthor) |
| C4  | Reject with an empty reason                         | Reject button disabled until a reason is entered    | ✅ (ui.tsx `!reason.trim()`)                             |
| C5  | Reject with a reason                                | Status REJECTED; reason recorded and visible        | ❓ reason shown later?                                   |
| C6  | Viewer views a pending campaign                     | Read-only; no approve/reject                        | ✅ (RBAC)                                                |

---

## D. Execution, probe & kill switch — (includes the concrete auto-kill case)

| ID  | Journey                                                    | Expected result                                                                                                                | Verdict                                                                                                         |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| D1  | Run an approved, bounded campaign against a healthy target | Live view shows elapsed + probe health; ends COMPLETED with a WRS                                                              | ❓                                                                                                              |
| D2  | Live stream (SSE) during a run                             | UI updates progressively (probe availability, elapsed), not only at the end                                                    | ✅ (SSE endpoint + runner ticks) — ❓ UI reflects it                                                            |
| D3  | Manual kill during a run                                   | Run stops promptly; status KILLED_MANUAL                                                                                       | ✅ (kill switch) — ❓ UI confirms who/when                                                                      |
| D4  | **Target goes down > 30 s during a run (auto-kill)**       | Run auto-stops; status KILLED_AUTO; **the UI explains why** ("target unavailable ≥ 30 s") with the measured probe availability | ✅ **FIXED** — `statusDetail` persisted + rendered as a kill note (backend + component tests)                   |
| D5  | Auto-kill with notifications configured                    | A `campaign.killed` notification is sent stating "target unavailable"                                                          | ✅ (notify/events.ts)                                                                                           |
| D6  | Auto-kill WITHOUT notifications                            | Operator can still understand the cause **from the UI alone**                                                                  | ✅ **FIXED** — the kill note shows in the card and the detail drawer, no notification needed                    |
| D7  | Kill an already-finished campaign                          | No-op / clear "not running" message, no error                                                                                  | ❓                                                                                                              |
| D8  | Absolute timeout reached (≤ 15 min)                        | Run stops cleanly at `maxDurationSec`                                                                                          | ✅ (by design) — the timeout is the **normal** stop signal that ends the probe loop → COMPLETED; not an anomaly |
| D9  | Concurrency guard (too many runs in flight)                | New run rejected with a clear reason, not a silent failure                                                                     | ❓                                                                                                              |
| D10 | Baseline capture fails before load                         | Run degrades gracefully (baseline optional); no crash                                                                          | ✅ (captureBaseline `.catch`)                                                                                   |

### Focus D4/D6 — the auto-kill explanation gap (critical)

**Root cause (code):** `Probe.evaluateAutoKill` fires `KILLED_AUTO` after 30 s of
consecutive probe unavailability. The runner stores `status: 'KILLED_AUTO'` on
the run — **and nothing else that explains it**. The run object carries the probe
metrics (`available/samples`, `errorRate5xx`) and a timeline, but no `reason`
string tying the kill to its cause.

**What the UI shows:** the status label `KILLED_AUTO → "Auto-killed"` (`ui.tsx`).
No tooltip, no sentence, no highlight of the probe availability drop.

**Where the "why" actually lives:** only in the notification body
(`notify/events.ts`: _"hit the automatic kill switch ... (target
unavailable)"_), which requires `NOTIFY_*` to be configured.

**Expected result (what "coherent" would be):** a killed run should state, in the
UI, _why_ — e.g. a line "Auto-killed: target was unavailable for 30 s (probe
availability fell to X%)", ideally next to the probe availability chart/timeline.

**Verdict:** ✅ **FIXED.** The run (and the campaign) now persist a `statusDetail`
string set at kill time from `killSwitch.reason` + the probe metrics, e.g.
_"Auto-killed: the legitimate probe found the target unavailable for ≥30 s
(availability 12% over 8 checks). The kill switch stopped the run to protect the
target."_ It renders as a red **kill note** on the campaign card and in the
detail drawer, so the cause is visible in the UI alone — no notification needed.
Covered by `runner.test.ts` (backend derivation) and `ui-components.test.tsx`
(rendering). This was the direct explanation for "I saw an auto-kill and no
explanation."

---

## E. Reports, runs & WRS

| ID  | Journey                                       | Expected result                                                       | Verdict                                                   |
| --- | --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| E1  | Reports with no runs yet                      | Empty state: "No campaign has run yet — no report available"          | ✅ (pages.tsx)                                            |
| E2  | Open a completed run's report                 | Shows WRS, probe availability, latency percentiles, posture, timeline | ❓                                                        |
| E3  | Open a **killed** run's report                | Report opens and clearly marks it as killed **with the reason**       | ✅ (fixed via `statusDetail`; shown in the detail drawer) |
| E4  | WRS marked "estimated" (no protection source) | Badge/label says estimated; not presented as measured                 | ✅ (wrs.estimated) — ❓ UI label                          |
| E5  | Export `runs.csv`                             | Downloads a CSV of runs matching the view                             | ❓                                                        |
| E6  | Export a run's `timeline.csv`                 | Downloads the per-second timeline                                     | ❓                                                        |
| E7  | WRS history for a target                      | Chronological WRS per target; regression vs previous visible          | ❓                                                        |
| E8  | Compliance report                             | Aggregated compliance view renders                                    | ❓                                                        |

---

## F. Audit & integrity

| ID  | Journey                                | Expected result                                              | Verdict                                             |
| --- | -------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| F1  | Open Audit                             | Chronological, append-only event list                        | ❓                                                  |
| F2  | Verify integrity (intact chain)        | "Verified/OK" — hash chain consistent                        | ✅ (endpoint) — ❓ UI copy                          |
| F3  | Verify integrity (tampered)            | Clearly flags tampering and where ("broken at #n (reason)")  | ✅ (pages.tsx/516)                                  |
| F4  | Export audit                           | Downloads the audit trail                                    | ❓                                                  |
| F5  | A killed campaign's lifecycle in audit | create → approve → run → **killed (with cause)** all present | ⚠️ verify the kill event carries the cause in audit |

---

## G. Playbooks & suites

| ID  | Journey                                        | Expected result                                        | Verdict      |
| --- | ---------------------------------------------- | ------------------------------------------------------ | ------------ |
| G1  | List built-in playbooks                        | Curated playbooks visible                              | ❓           |
| G2  | Create a custom playbook                       | Persisted; appears in the list                         | ❓           |
| G3  | Create a playbook with an off-allowlist target | Rejected (same allowlist rule as campaigns)            | ✅ (backend) |
| G4  | Delete a custom playbook                       | Removed; built-ins not deletable                       | ❓           |
| G5  | Run a suite                                    | Sequenced runs execute under the same caps/kill switch | ❓           |
| G6  | Suite report                                   | Aggregated per-suite results                           | ❓           |

---

## H. Settings & user management

| ID  | Journey                        | Expected result                                         | Verdict                                    |
| --- | ------------------------------ | ------------------------------------------------------- | ------------------------------------------ |
| H1  | Officer opens Settings         | Engine/security info + user management visible          | ✅ (pages.test)                            |
| H2  | Engineer/viewer opens Settings | User management hidden (user:manage is officer-only)    | ✅ (RBAC)                                  |
| H3  | Officer creates a user         | User added; appears in the list                         | ❓                                         |
| H4  | Officer changes a user's role  | Patched; effective immediately for that user            | ❓                                         |
| H5  | Officer deletes a DB user      | Removed; **env-defined (root) users cannot be deleted** | ✅ (env users immutable) — ❓ UI blocks it |
| H6  | Weak/short password on create  | Rejected (min length, scrypt hash)                      | ✅ (backend) — ❓ UI message               |
| H7  | Notification test button       | Sends a test event; success/failure surfaced            | ❓                                         |

---

## I. Notifications

| ID  | Journey                        | Expected result                                       | Verdict        |
| --- | ------------------------------ | ----------------------------------------------------- | -------------- |
| I1  | Campaign completes             | `campaign.completed` event (if NOTIFY_* configured)   | ✅ (events.ts) |
| I2  | Campaign auto-killed           | `campaign.killed` event stating "target unavailable"  | ✅ (events.ts) |
| I3  | WRS regression vs previous run | Regression event emitted                              | ✅ (events.ts) |
| I4  | No NOTIFY_* configured         | No events; UI still fully usable (no hard dependency) | ✅             |

---

## J. Cross-page coherence (the heart of "all journeys are consistent")

| ID  | Journey (spans pages)                                                         | Expected result                                  | Verdict                                           |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| J1  | Create → it shows in Campaigns; after run → in Reports; events → in Audit     | Same campaign/run identity and status everywhere | ❓                                                |
| J2  | Overview counters vs Campaigns/Reports lists                                  | Counts match the underlying lists (no drift)     | ❓                                                |
| J3  | A killed run's status is identical in Campaigns, Reports, Audit, WRS history  | One truth for the status **and its cause**       | ✅ (cause now on the campaign + run + audit line) |
| J4  | WRS shown on a run detail == WRS in WRS history for that run                  | Identical value and estimated/measured flag      | ❓                                                |
| J5  | An engine marked "not installed" in Settings behaves consistently in the form | Same availability signal in both places          | ❓                                                |

---

## K. RBAC matrix (no visible action should lead to a 403)

For each role, the nav + buttons shown must equal what the API allows.

| Action / role         | engineer | officer | viewer | Verdict                                 |
| --------------------- | :------: | :-----: | :----: | --------------------------------------- |
| See campaigns/reports |   yes    |   yes   |  yes   | ✅                                      |
| Create campaign       |   yes    |   yes   |   no   | ❓ verify no create button for viewer   |
| Approve/reject        |    no    |   yes   |   no   | ✅ (approve hidden for engineer/viewer) |
| Execute               |   yes    |   yes   |   no   | ❓                                      |
| Kill                  |   yes    |   yes   |  yes   | ✅ (all roles have campaign:kill)       |
| Manage users          |    no    |   yes   |   no   | ✅                                      |

**Coherence rule under test:** render each page as each role and assert that
every actionable control maps to an allowed permission — catch any button that
would return 401/403.

---

## L. Robustness / non-functional

| ID  | Journey                            | Expected result                                         | Verdict                              |
| --- | ---------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| L1  | API returns 500 on a list fetch    | Page shows an error state, not a blank/white screen     | ❓ (simulate via route interception) |
| L2  | Slow API (latency)                 | Loading state shown; no duplicate submits               | ❓                                   |
| L3  | Every page in dark and light theme | Legible; no unreadable contrast                         | ❓ (theme.ts exists)                 |
| L4  | English-only copy across all pages | No residual non-English strings                         | ❓ (assert in E2E)                   |
| L5  | Basic a11y per page (roles/labels) | axe-core: no critical violations                        | ❓                                   |
| L6  | Reload mid-run                     | Live view recovers state from the API (run keeps going) | ❓                                   |

---

## Summary — what this pass produced

**Fixed (was the reported symptom):**

- ✅ **D4 / D6 / E3 / J3 — auto-kill now explains itself.** Runs persist a
  `statusDetail` (from `killSwitch.reason` + probe metrics); the campaign mirrors
  it; the UI shows a red kill note on the card and drawer; the audit line carries
  it too. Regression tests in `runner.test.ts` and `ui-components.test.tsx`.

**Corrected on review (was a false positive):**

- ✅ **D8 — TIMEOUT is not an anomaly.** The absolute timeout is the normal stop
  that ends the probe loop at `maxDurationSec`; mapping it to COMPLETED is
  correct by design.

**Covered by the Playwright suite (`e2e/`, 14 specs green):**

- A1/A2/A3/A5/A6/A7 (auth, session-persist, logout, SPA fallback), navigation
  across all sections + E1 empty state, K/C1 (viewer can't create, engineer
  can't approve), C3 (officer can't approve own), the full B→C→D→E lifecycle
  (create → approve → **engineer** runs → complete → shows in Reports = J1) with
  the officer having no Run action (SoD), and B3 (off-allowlist target flagged).

**Now executed by the data-driven catalog (`backend/test/catalog/`, 334 cases):**

- **Exports/reports** E2/E4/E5/E6/E7/E8 (run detail, HTML report, timeline.csv,
  runs.csv, compliance, WRS history, estimated flag); **audit** F1/F2/F4 (list,
  verify intact, export, grows with activity); **playbooks/suites**
  G1/G2/G4/G5/G6 (list, create/delete custom, reject empty, instantiate, suite
  report); **users** H3/H4 + full lifecycle (create → login → role change →
  delete → login fails; self/env protected); **C5** (rejection reason persisted);
  **D7** (kill a finished campaign → 404). Plus the whole RBAC matrix, allowlist
  (4 fields), caps, attestation, login+lockout, read-token routes, unknown
  routes, and scenario/flow/recurrence bounds.
- **Every campaign shape** (area SHAPE): created (201) for all vectors, profiles,
  multi-phase scenario, flow (± correlation), endpoint mix, UA rotation, data
  feeder, assertion, acceptance SLO, recurrence, scheduling and each engine
  (builtin/k6/vegeta/locust/jmeter/gatling); engine-capability conflicts
  rejected (400); and a representative set **run end-to-end to COMPLETED** with
  its real feature signal (assertions checked, ≥2 UAs seen, dataset value
  substituted, both endpoints hit, both flow steps hit, POST, multi-phase). An
  **unavailable external engine now falls back to the built-in engine** at
  execution (matching the UI's "→ default" hint) instead of failing the run.

**Still open (need visual/tooling, not pure assertions):**

- ⚠️ **B6/B7/B8 — client vs server cap coherence** (assert the form blocks
  values the server would reject before submit).
- ❓ **L1/L2 error & loading states** (needs route-interception UI assertions),
  **L3 dark/light legibility**, **L4 English-only sweep**, **L5 a11y (axe)**,
  **L6 reload mid-run**, **D2 live SSE reflected in the UI**. These are the
  UI-rendering rows a future E2E/visual pass would close.
