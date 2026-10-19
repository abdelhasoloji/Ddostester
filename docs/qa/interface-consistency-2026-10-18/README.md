# Interface consistency review — 18 October 2026

Source base: `8d39dcb`, branch `codex/zerobs-classic-three-pods`. Local changes only; no deployment.

## Changes

- Compact shared page/card spacing, consistent wrapping actions and shrinkable form tracks.
- Mobile navigation remains fully available in one horizontally scrollable row. The page heading moves from approximately 348px to 189px from the viewport top at 390px width.
- Account cards no longer stack their outer margins on the grid gap. Assistant mascot reduced from 196px to 64px tall on its full-page view; dock behavior preserved.
- Template titles, badges and help triggers wrap without clipping. Duplicate target-picker chips removed without changing authorization. Target registration required marker stays on its label line.
- Fleet management buttons use the shared button treatment. Header actions and result export buttons align consistently.
- Shared dialogs render above clipping contexts, scroll within the viewport, lock background scrolling, contain keyboard focus and restore their trigger. Initial focus goes to an action rather than opening incidental help.
- Help bubbles use viewport positioning with scroll/resize updates, keyboard/touch activation and Escape dismissal. Escape dismisses help before its enclosing dialog. Clicking help does not toggle an enclosing template summary.
- Theater charts fit three columns at the reviewed desktop width and one column on mobile. Fractional HTTP generator failure percentages remain visible (2 failures / 500 requests displays 0.4%, matching its graph) instead of rounding to zero. Connection-hold presentation retained.
- Explicit dark theme now selects the white logo, while forced light keeps the light-theme logo. The Theater was checked in dark mode and the original system preference restored.
- Route/tab fade effects removed so controls are readable immediately; live widget animations retained.
- Test fetch stubs use `globalThis` to resolve existing frontend type-check errors.

## Browser coverage

Chrome, local isolated fixtures only. Default desktop viewport 1200px wide; mobile viewport 390 × 844. Screenshots use actual application components and server routes. Full-page images include content below the viewport; they do not imply every control is simultaneously visible.

The following eleven views were visited at both widths and captured: overview, protected zones, template catalogue, campaign history, DRS assessment, completed Run Theater, results, Fleet, assistant, settings and account. Width checks are in `desktop-checks.json` and `mobile-checks.json`; the final checks show no document-level horizontal overflow. Wide data tables retain internal scrolling.

Additional checks: current target registration form; template expansion and generator selection; execution confirmation opened and cancelled; campaign detail panel; notifications; keyboard focus/restore and Escape; short 390 × 480 viewport (448px dialog height, 569px scroll content, Cancel still reachable); mobile help bubble bounds; recorded final report; live Theater SSE rendering using explicitly seeded demonstration telemetry. Login and mandatory-password-change screens were viewed on desktop/mobile with a fictitious local identity. No new password was entered or changed.

## Isolation and limits

All displayed targets (`*.example`), campaigns and metrics are **demonstration data**, not resilience evidence or production records. The live fixture serves a fixed seeded SSE snapshot; it does not generate load or validate a real campaign's timing. The report is a presentation fixture. No traffic-generating campaign, production mutation, real sign-in or deployment occurred.

`shield-ui-review.mjs` starts loopback port 18110 using memory storage and rejects all non-read requests. `shield-ui-auth-review.mjs` starts ports 18111/18112: 18112 has a fake login response solely to display the forced-change gate; all credential changes and other mutations are rejected. Random signing secrets are ephemeral, no usable credentials are retained. Run fixtures with Node 22 after building the repository. Stop them after review.

This verifies the routed screens and principal presentation paths. Real provider responses, full production history, every authorization role, every error combination and live external campaign execution were not exercised. Third-party Grafana rendering is not qualified by these fixtures.

## Automated validation

- Full frontend regression: 59 files, 480 tests passed.
- Frontend TypeScript check passed after replacing obsolete test globals.
- ESLint on changed components/tests passed; production frontend build passed (existing large-bundle advisory remains).
- Earlier attempts before the workstation restart timed out; successful results above supersede those infrastructure failures.

## Deep-scroll popup regression

The composed-template generator dialog was opened after scrolling over 2,100px down the catalogue. It remained inside the visible 934px-high viewport (top 191.5px, bottom 742.5px), attached directly to `BODY`, with background scrolling locked. See `popup-deep-scroll-check.json` and `popup-after-deep-scroll.jpg`. Initial focus and trigger restoration now use `preventScroll` so focus handling does not move the underlying document. This is a local verification; the old deployed bundle is not changed by a local commit.
