# Usage walkthrough

Prerequisites: service deployed, SSH tunnel open, `http://localhost:8080` reachable.

## Guided new-campaign wizard

The **＋ New campaign** button opens a 4-step guided journey — **Objective →
Target → Template → Review**:

1. **Objective** — say what you want to learn (readiness, capacity, spike
   resilience, threat-informed, endurance). This filters the catalogue.
2. **Target** — pick an allowlisted host (one-click chips). The wizard shows the
   target's last WRS and whether a regression was seen.
3. **Template** — a unified catalogue of presets (single tests) and playbooks
   (multi-step assessment suites). The best-fit is **pre-selected and marked ★
   Recommended**, chosen from the target's history (first run → gentlest; strong
   last score → step up; regression → re-baseline), installed engines, and the
   current effective caps. Each card shows peak RPS, duration, estimated requests
   and DRS level; a template above the current operational limit is disabled with
   the exact reason.
4. **Review** — a summary (what will run, volume, "within effective caps ✓"),
   the authorization attestation, and **Create**. A preset creates one campaign;
   a playbook instantiates the whole suite. **Advanced** opens the full classic
   form, seeded with your choices.

## Closed-loop test (validating the chain)

Without configuring any external target, you can validate the whole pipeline by
aiming at the service itself (`127.0.0.1`, already in the allowlist). You can use
the guided wizard above, or the classic form directly.

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

## Assessment playbooks (one-click sequences)

Instead of building campaigns one by one, launch a **curated assessment** — an
ordered sequence of bounded campaigns — from **Guide → Assessment playbooks**:

- _Quick readiness check_ — smoke → baseline.
- _Capacity assessment_ — baseline → ramp → capacity ceiling.
- _Burst resilience_ — baseline → spikes/waves.
- _Endurance / soak_ — a long gentle load.

Pick an allowlisted target and launch: the whole set of campaigns is created
(linked by a suite id, shown with a 📋 badge). **Governance is unchanged** — each
campaign is created `PENDING_APPROVAL` and still needs an officer's approval
before it runs. `GET /api/playbooks` lists them; `POST /api/playbooks/:id/instantiate`
(`{ "target": "https://…" }`) creates the suite.

**Custom playbooks.** Beyond the curated ones, you can define your own from
**Guide → Custom playbook** (or `POST /api/playbooks`): a name and a JSON list of
steps (`name, maxRps, concurrency, maxDurationSec, profile, agent?`). Every step
is validated against the caps — a custom playbook can never widen the bounds.
They are stored, marked `custom`, and deletable (`DELETE /api/playbooks/:id`);
curated playbooks are read-only. Assessments run consolidated in **Reports →
Assessment suites**, with a single HTML report.

## Acceptance criteria — SLO pass/fail

Set thresholds on a campaign and each run gets an explicit **PASS/FAIL verdict**
(the missing link between "we measured" and "the target is resilient"):

- `maxP95Ms` — max generator latency p95,
- `maxErrorRatePct` — max error rate,
- `minAvailabilityPct` — min probe availability,
- `minWrs` — min WRS.

The verdict is computed from metrics we already collect, so it works with **any
engine**. It shows as an **SLO PASS/FAIL** badge on the campaign and run,
lists the breached criteria, is included in notifications (a failed SLO raises
the completion alert), and aggregates at the **suite** level (an assessment is
PASS only if no member failed). Leave the criteria empty to skip.

## Protection posture (inferred, passive)

Every run now infers the target's protection posture **from the legitimate
probe's own responses** — no scanning, no extra traffic. It flags whether a
**WAF/CDN**, **rate limiting**, a **load balancer** and **HSTS**/hardening
headers are present, plus the reported `Server`. It appears in the run details
and the HTML report. This is the safe equivalent of Avydos' misconfiguration
detection: it reads response metadata already returned to the probe.

## Request flows — L7 journeys (bounded)

A campaign can send a realistic multi-step **journey** instead of hammering one
URL — e.g. `GET /` → `POST /login` → `GET /dashboard` → `GET /logout`. In the
form's **Request flow** editor, one line per step:

```
METHOD /path [thinkMs]
```

- Each step hits the campaign target's host, so it stays inside the allowlist.
- The global `maxRps` still caps the **total** request rate: engines that count
  iterations run at `maxRps / steps` iterations per second, so N steps ≈ `maxRps`
  requests per second, never more.
- `thinkMs` is an optional pause **between** complete requests — it only lowers
  load (it is not a slow-loris style vector).

Supported by the built-in engine and k6, JMeter, Gatling and Locust. Vegeta is
fixed-rate single-request only. Flows combine with load profiles (the profile
shapes the rate over time; the flow defines what each iteration does).

### Correlation — authenticated journeys (built-in engine)

Switch the flow editor to **Advanced (JSON)** to author steps with per-step
headers and **correlation**: extract a value from a step's response and reuse it
in later steps as `{{name}}`. Example — log in, then call an authenticated
endpoint with the returned token:

```json
[
  {
    "method": "POST",
    "url": "https://staging.example.com/login",
    "body": "{\"user\":\"probe\",\"pass\":\"…\"}",
    "extract": { "name": "token", "from": "json", "expr": "data.token" }
  },
  {
    "method": "GET",
    "url": "https://staging.example.com/api/me",
    "headers": { "Authorization": "Bearer {{token}}" }
  }
]
```

`extract.from` is `json` (dot-path), `header`, or `regex` (first capture group).
Correlation runs on the **built-in engine** (it is applied per virtual user);
other engines run flows without correlation. Still bounded HTTP to allowlisted
hosts under the same caps.

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

## Shareable read-only links (RPT-04)

**Reports → Copy share link 🔗** mints a **short-lived, read-only** token
(`POST /api/share`, viewer scope, 24 h by default; TTL capped at 7 days) and
copies an absolute compliance-report URL carrying it. The recipient opens the
report without an account; the link only reads (it cannot create/approve/execute
anything) and expires. Minting is authenticated and audited (`share.create`); a
link is invalidated early by rotating `AUTH_JWT_SECRET`. When auth is disabled
(dev), the plain URL is copied (no token needed).
