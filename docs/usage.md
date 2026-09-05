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

## Best practices

- Always start low and increase in steps.
- Keep a tab on the target's own metrics in parallel.
- The **manual kill switch** is there in case of doubt: `POST /api/campaigns/:id/kill`.
- Never aim at a target outside the mandated scope (the allowlist guarantees this).

## Load profiles (bounded scenarios — GEN-03)

In the form, “Load profile” translates Max RPS + duration into phases:

- **Constant** — single rate (default).
- **Ramp-up** — 25 % → 50 % → 100 % of Max RPS over three thirds.
- **Waves** — 100 % → 20 % → 100 %.

Each phase remains subject to the caps (`maxRps ≤ 2000`, total duration ≤ 900 s).
No volumetric vector: these are only modulated, bounded HTTP rates.

## PDF export of reports (RPT-01)

Each report (campaign and compliance) has a **“Print / PDF”** button that opens
the browser's print dialog → “Save as PDF”. A print stylesheet hides the
controls and lays the page out cleanly, with no server dependency (no headless
engine to install on the target).
