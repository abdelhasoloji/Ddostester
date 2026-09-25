# Probe agent (VPS2) — remote read-only availability vantage

A tiny, zero-dependency service that lets a ShieldTest campaign measure a target's
availability **from VPS2's source IP** instead of the control plane's (VPS1). Use
it when the target rate-limits by source IP, so the probe would otherwise collide
with the load generator's IP (e.g. the ENISA preprod portal: 1 connection/IP).

It is strictly defensive: **one bounded GET per request, to an allowlisted host
only**, bearer-token auth, small timeout, a rate cap. No load generation.

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
sudo cp probe-agent.mjs /opt/probe-agent/
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
