# DRS load plane

The plane that produces load for a DRS exposure, rendered from the envelope the product
computed — not handwritten per test.

## Why one Deployment per identity

Every worker authenticates with an mTLS certificate whose CN is its agent id, and the
coordinator's claim is atomic per shard. Two replicas sharing one certificate would race
for the same shard and the loser would idle forever. **Scaling means adding an identity**,
so the renderer emits `drs-worker-agent-1 … drs-worker-agent-N`, one Secret each.

## Render

```bash
# agents from the product's own answer
curl -s --cert client.crt --key client.key https://control/api/drs/capacity > capacity.json
node render-load-plane.mjs --capacity-json capacity.json \
  --image ghcr.io/<owner>/ddostester-lab-control@sha256:<digest> \
  --control https://<coordinator>:8443 --site <site> > load-plane.yaml

node check-load-plane.mjs load-plane.yaml <expectedAgents>
kubectl apply -f load-plane.yaml
```

`envelope.agents` is the number of **admitted** agents — those with a recorded calibration.
The same number is what `levelReachability` compares against a vector's `max_bots`, so the
plane is sized by the same arithmetic that decides whether a level is reachable.

## What this does not claim

A pod produces requests, not bandwidth or source diversity. Volumetric (`bps`/`pps`)
requirements and `max_bots` beyond the admitted identities stay unmet and are reported as
such by the assessment; the load plane must never be cited as evidence for them.
