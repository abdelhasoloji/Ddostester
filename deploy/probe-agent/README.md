# Probe agent (VPS2) — remote read-only availability vantage

A tiny, zero-dependency service that lets a ShieldTest campaign measure a target's
availability **from VPS2's source IP** instead of the control plane's (VPS1). Use
it when the target rate-limits by source IP, so the probe would otherwise collide
with the load generator's IP (e.g. the ENISA preprod portal: 1 connection/IP).

It is strictly defensive: **one bounded GET per request, to an allowlisted host
only**, bearer-token auth, small timeout, a rate cap. No load generation.

The agent also bounds concurrent measurements with `PROBE_AGENT_MAX_IN_FLIGHT`
(default 2, permitted range 1–4). Excess requests receive 429 and must be treated
as unavailable measurement transport, rather than proof of a target outage.
Slots include request-body reading and response draining, and are released even
on validation failures. Request bodies have a two-second read deadline; HTTP
headers/requests have five-second server deadlines and at most 64 open sockets.
These bounds complement the independent CPU/memory allocation. Each measurement
also returns `ddostester.probe.quality/v1`: process CPU deltas, RSS, event-loop
delay maximum (20 ms sampling resolution) and cgroup v2 throttled-time delta.
Unavailable counters stay null. Concurrent measurements overlap this process
accounting; CPU deltas must not be summed as independent request costs. The
control plane keeps coverage, peaks and the latest diagnostic in the run/export.
Missing coverage, unavailable counters and observed contention degrade confidence
without modifying target scores or disabling protective kill thresholds. These
are probe diagnostics, not target CPU measurements or proof of network health.

## Contract

- `POST /probe` (auth: `Authorization: Bearer <PROBE_AGENT_TOKEN>`)
  body `{ "url": "https://host/path", "timeoutMs": 8000 }`
  → `200 { ok, status, latencyMs, headers, bodySlice? }`
- `GET /health` → `200 { ok: true }` (no auth)

The control plane (VPS1) calls this automatically when a campaign's **probe
vantage** is set to _remote_ and `PROBE_AGENT_URL` / `PROBE_AGENT_TOKEN` are set
in the control plane's env.

## Deploy on VPS2

Prereqs: Node ≥ 20, Tailscale up on VPS1 and VPS2 (same tailnet).

```
# 1. Tailnet IP of VPS2:
tailscale ip -4                      # e.g. 100.101.102.103

# 2. Install the agent:
sudo mkdir -p /opt/probe-agent
sudo cp probe-agent.mjs quality.mjs /opt/probe-agent/
sudo cp probe-agent.env.example /etc/probe-agent.env
sudo $EDITOR /etc/probe-agent.env    # set TOKEN (openssl rand -hex 32),
                                     # ALLOWLIST, BIND=<tailnet IP>
sudo cp probe-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now probe-agent

# 3. Verify from VPS1 (over the tailnet):
curl -s http://<VPS2-tailnet-ip>:8099/health
curl -s -X POST http://<VPS2-tailnet-ip>:8099/probe \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://portal.preprod.cra-srp-pp.enisa.europa.eu/"}'
```

## Wire the control plane (VPS1)

Add to `/etc/ddostester.env` and restart the service:

```
PROBE_AGENT_URL=http://<VPS2-tailnet-ip>:8099/probe
PROBE_AGENT_TOKEN=<same token as VPS2>
```

`/health` then reports `remoteProbe: true`, and the campaign form shows the
**probe vantage** selector (Local VPS1 / Remote VPS2). Pick _Remote (VPS2)_ for
the ENISA campaign.

## Security notes

- Bind to the **tailnet** interface (`PROBE_AGENT_BIND=<tailscale IP>`), so the
  agent is not publicly reachable. Do not expose port 8099 publicly.
- The allowlist is enforced independently of the control plane — the agent will
  only GET hosts you list here.
- No method/body is forwarded to the target; it is always a plain GET.

### Continuous event-loop diagnostics

Quality v1 retains per-measurement CPU/cgroup accounting and event-loop delay.
An additive `recentEventLoop` object reports the process between requests:
`scope=process-recent-window`, actual `windowMs`, positive histogram `samples`
and `maxMs`. It is null before any sample. The monitor rotates once per second,
retains at most ten completed windows and excludes windows older than ten seconds.
A boundary window may overlap that cutoff; `windowMs` records the actual span.
Requests do not reset this shared monitor. Values are correlated process diagnostics,
not an independent latency measurement or a per-request CPU cost.

The implementation uses the interval-based
[Node event-loop monitor](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)
at 20 ms resolution, compatible with the pinned Node 22 runtime; it does not use
newer per-iteration/snapshot APIs. The summary keeps per-request and recent-window
peaks separately. Fewer than 90% of measurements with known event-loop diagnostics,
or a peak above 100 ms, degrades measurement confidence; WRS and kill thresholds
are not recalculated. Legacy samples without this object remain readable, with
missing diagnostics unknown. The private Linux lab runs the source-06 probe/control images. Versioned
requests and legacy compatibility are verified there; complete fleet/phase
validation and Mac parity remain pending.

### Fresh response protocol and rollout order

New control-plane requests use `ddostester.probe.request/v2` and a random 128-bit
hex `requestId`. The probe replies with `ddostester.probe.response/v2`, echoes that
identifier and adds `observedAt` after measurement. Baseline, live measurements
and recovery all require the matching envelope. Observation and diagnostic dates
must fall within the request window, allowing at most two seconds of clock skew;
a local clock moving backwards also invalidates the response. A replay, missing
envelope, old diagnostic or excessive clock offset fails the measurement. No
local-vantage fallback occurs. Agent authentication remains required; this
challenge is freshness evidence from a trusted agent, not a signed receiver proof.

The new probe still answers legacy requests without an envelope so it can be
rolled out first. These legacy responses do not establish freshness for a new
control plane. `/health` advertises the v2 request protocol. Upgrade the probe,
verify a real versioned request, then upgrade the control plane. A new control
plane paired with an old probe refuses its responses instead of trusting them.
Historical stored samples remain readable; they are not retroactively validated
or rescored. The private Linux source-06 lab has been upgraded probe-first and its v2
transport checked. The deployed control-plane checkpoint is documented separately in `docs/current-setup.md`; this probe recipe does not establish a newer remote-probe deployment.
