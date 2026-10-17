# Campaign interface preview — 17 October 2026

Local working-tree preview, not a deployed release. Production remains build 476. No production account, campaign, generator, traffic limit or Pod was changed.

- Templates is the default and sole campaign creation destination; campaign history and assessment evidence use separate tabs.
- Legacy launch/plan/guide entry URLs resolve to templates. The Fleet form continues a selected Fleet template; selected DRS profiles retain their form handoff.
- Synthetic requests are offered inside the template catalogue. Theater and Settings link to that catalogue while retaining result/report access.
- Template explanations use focusable help tips; target, budget, scope limitations and approval/confirmation remain available. Navigation and theme controls share outline SVG icons. The assistant defaults closed without overriding a saved preference.

Validation: 461 frontend tests passed; targeted creation/history, Fleet template continuation, read-only Theater and polling regressions passed; lint, type checking and builds passed. Local MemoryStore browser review verified the legacy launch URL selecting Templates, the compact layout, outline icons and focusable workflow help. The preview has no configured runner and emitted no traffic. Screenshots use development fixtures and are not production acceptance evidence.

`templates.png` shows the default catalogue; `help.png` shows the workflow tooltip. The temporary preview was stopped after review.
