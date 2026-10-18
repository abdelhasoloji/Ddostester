# Individual Run Theater graphs — 18 October 2026

## Source behavior

Four default HTTP cards show interval emission/successful responses, completed monitored checks, cumulative probe latency percentiles and interval finalized-request failures. The graph catalogue offers HTTP response classes, connection diagnostics, probe sampling quality and independently collected target CPU/network/conntrack when present. Missing received-load, generator-resource, Fleet and post-run recovery evidence stays unavailable.

Each card expands into a viewport-contained dialog with series switches, time windows/custom interval, display-only threshold, CSV export and a campaign-scoped deep link. Availability can be filtered by monitored URL. Pause freezes the view, not the execution or evidence collection. Saved pins are local display preferences, limited to four cards. Live and recorded views use the same transformations. Existing historical samples retain an explicitly cumulative fallback where exact probe counts were not stored.

Generator status-family counters, probe successes, percentile snapshots and monitored-URL counts are now retained alongside bounded timeline samples. Counter resets/unobserved generator ticks are excluded from interval calculations. Failures are divided by finalized outcomes rather than emitted requests. A primary-URL baseline is omitted for multi-URL latency aggregates. No execution limits, approval/account policies or Pod definitions changed.

## Checks

The disposable `local-journey.mjs` fixture binds only loopback ports 18110/18120, uses memory storage and allows execution only for its approved 20 RPS / 20 second campaign. The target intentionally returns one HTTP 503 in 25 load requests; monitored URLs remain healthy. This is an application journey check, not resilience qualification.

Browser qualification observed launch confirmation, running telemetry, individual load graph, pause while collection continued, custom 2–6 second window, series switching and a completed campaign reopened by graph deep link. `individual-graph-desktop.png` records the local paused view. Further acceptance/deployment results are recorded separately; the screenshot is not production evidence.

Pure/UI tests cover interval bursts, resets, missing samples, finalized denominators, per-URL probe observations, unavailable instrumentation, connection units, CSV escaping, scoped dialogs, pause/resume, focus restoration and deep-link filters. Backend loopback tests verify persisted evidence snapshots; an initial test assumption that the first tick already contained generator counters was corrected to select an observed tick.

Additional browser checks passed: filtered secondary-URL observations, link-copy confirmation, downloaded load/availability CSV files and final report navigation. The loopback run completed with 400 requests (384 successes, 16 intentional HTTP failures), no transport failures and 4/4 monitored cycles. At 390×844 the dialog bounds were x=16, y=16, width=358, height=812, with no horizontal overflow; scrolling stays within the dialog. Mobile screenshot and sample CSV are retained. The browser download-event waiter timed out, so download success was checked from the actual CSV files instead.
