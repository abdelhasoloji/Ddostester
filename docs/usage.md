# Usage walkthrough

Prerequisites: service deployed, SSH tunnel open, `http://localhost:8080` reachable.

## Closed-loop test (validating the chain)

Without configuring any external target, you can validate the whole pipeline by
aiming at the service itself (`127.0.0.1`, already in the allowlist).

1. **New campaign**:
   - Name: `Autotest`
   - Author: your identifier
   - Target: `http://127.0.0.1:8080/health`
   - Probe: `http://127.0.0.1:8080/health`
   - Vector: `http-get`, Max RPS `20`, Concurrency `5`, Duration `30`
   - ☑ Attestation → **Submit**
2. **Approve** (Actions column). _(in the UI the default approver is
   `officer@wedos`; via the API it must differ from the author.)_
3. **Execute** → the generator and probe run for 30 s.
4. **Report** → opens the HTML: WRS, latencies, availability, final status.

## Campaign against an authorized target

1. Add the target to the allowlist (see [deployment.md](./deployment.md)):
   ```bash
   ALLOWED_TARGETS="127.0.0.1,test-host.internal" bash deploy/setup.sh
   ```
2. Verify the target responds from the server:
   ```bash
   curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" http://test-host.internal/health
   ```
3. Create the campaign with this target, **starting cautiously**:
   `Max RPS 20`, `Concurrency 5`, `Duration 30 s`.
4. Approve, execute, **watch the probe** (latency, 5xx rate).
5. Increase intensity **gradually** only if the environment holds up, and within
   the caps (`maxRps ≤ 2000`, `duration ≤ 900 s`).

## Recommended configurations (presets)

The in-app **Guide** page proposes ready-made, bounded configurations and applies
them to the new-campaign form in one click (**Use this configuration**). Each
preset sets the load shape only — rate, concurrency, duration, profile — never
the target, so it is safe to apply to any allowlisted host.

| Preset              | Rate    | Conc. | Duration | Profile  | When to use                                        |
| ------------------- | ------- | ----- | -------- | -------- | -------------------------------------------------- |
| Smoke test          | 10 rps  | 3     | 20 s     | Constant | First run / confirm the pipeline works             |
| Baseline / capacity | 100 rps | 20    | 120 s    | Constant | Reference latency & availability under steady load |
| Ramp-up (find knee) | 300 rps | 50    | 180 s    | Ramp-up  | Find where latency/errors start climbing           |
| Spike / waves       | 500 rps | 100   | 180 s    | Waves    | Test reaction to sudden bursts, then recovery      |
| Soak / endurance    | 50 rps  | 20    | 900 s    | Constant | Reveal slow degradation / leaks over time          |

The form also shows an estimated request volume so you know the size of a run
before submitting it. Start with the smoke test, then move up as the target holds.

## Best practices

- Always start low and increase in steps.
- Keep a tab on the target's own metrics in parallel.
- The **manual kill switch** is there in case of doubt: `POST /api/campaigns/:id/kill`.
- Never aim at a target outside the mandated scope (the allowlist guarantees this).

## Scheduling & recurrence (CAM-01)

A campaign can run manually, once at a scheduled time, or repeatedly:

- **Schedule** — set a start time; once approved, the scheduler runs it then.
- **Repeat every** — pick an interval (15 min – 12 h) to re-run the campaign on a
  cadence (e.g. a nightly staging check). After each run it re-arms for the next.

Recurrence is deliberately bounded by governance: it **only fires while the
approval is still valid** (24 h) and, if set, before its end time. When the
approval window closes, recurrence stops and the campaign must be re-approved —
so automation never bypasses the approval workflow or separation of duties.
Combine it with [notifications](./notifications.md) to be alerted on completion
or a WRS regression instead of watching the UI.

## Load profiles (bounded scenarios — GEN-03)

In the form, “Load profile” translates Max RPS + duration into phases:

- **Constant** — single rate (default).
- **Ramp-up** — 25 % → 50 % → 100 % of Max RPS over three thirds.
- **Waves** — 100 % → 20 % → 100 %.

Each phase remains subject to the caps (`maxRps ≤ 2000`, total duration ≤ 900 s).
No volumetric vector: these are only modulated, bounded HTTP rates.

## Load engines (per campaign)

The form's **Load engine** selector chooses which generator runs the campaign:
the built-in engine (no install), or a team-operated external tool (k6, Vegeta,
Locust, JMeter, Gatling) — all bounded HTTP. Engines not installed on the server
are greyed out; constant-only engines (locust/jmeter/gatling) disable the
ramp/wave profiles. The **Guide** and **Settings → Load engines** pages show each
engine's install status and capabilities. See
[offensive-integration.md](./offensive-integration.md) for how engines are wired
and governed.

## PDF export of reports (RPT-01)

Each report (campaign and compliance) has a **“Print / PDF”** button that opens
the browser's print dialog → “Save as PDF”. A print stylesheet hides the
controls and lays the page out cleanly, with no server dependency (no headless
engine to install on the target).
