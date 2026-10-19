# Preparing a second fleet site (ac02)

Status: **preparation only, 19 October 2026.** No manifest is written yet, because
the site's reachable address, registry image and identity are infrastructure facts
that cannot be invented. This guide lists exactly what to produce; the code side
(M2.0–M2.6) is already in place.

The rule that governs everything below: **the aggregate is authorized once and then
divided.** A second site makes the authorized rate deliverable; it never raises it.
`authorizedEnvelope()` fixes the one envelope and `assertAggregateBudget()` refuses
shards that do not conserve it.

## 1. Image (the hard blocker)

The lab image is built locally and referenced as `ddostester-lab-control:local` with
`imagePullPolicy: Never`. A remote cluster cannot pull that. Publish it:

```
# Monorepo-aware build: the Dockerfile copies backend/, frontend/ and standards/.
docker build -f backend/Dockerfile -t <registry>/ddostester-lab-control:<tag> .
docker push <registry>/ddostester-lab-control:<tag>
# Record the digest; the fleet Job image is validated as a digest, not a tag.
docker inspect --format '{{index .RepoDigests 0}}' <registry>/ddostester-lab-control:<tag>
```

- Use a **digest**, never `:latest`: `KubernetesJobs` refuses a mutable tag, and
  `FLEET_AGENT_IMAGE` is checked against
  `docker.io/library/ddostester-lab-control@sha256:<64 hex>` today — a different
  registry means that pattern must be widened deliberately, as a reviewed change.
- The worker entrypoint is `node backend/dist/cli/fleet-worker.js`.

## 2. Identity (operator PKI, not code)

Per-agent client certificate from the offline CA, CN = the agent id (`three` for a
single ac02 agent). Create the Secret in the site's namespace:

```
kubectl -n <namespace> create secret generic fleet-three \
  --from-file=tls.key=<three.key> --from-file=tls.crt=<three.crt> --from-file=ca.crt=<ca.crt>
```

- Keys and the CA stay outside Git and outside the cluster; Secret mode `0400`
  (`defaultMode: 256`) is enough for the worker to read them.
- Leaves last 14 days and **renewal is manual**. The coordinator records each
  agent's `valid_to` on every authenticated request and reports `expiring` at seven
  days in `/api/fleet/status`, so expiry is visible — but it is not automatic.
- Register the agent once, in **one** place: `FLEET_SITES=three@ac02` on the control
  plane and the fleet server.

## 3. Reachability and SAN

The worker only dials out; the site needs no inbound port. Two viable paths:

| Path | What it needs | Trade-off |
| --- | --- | --- |
| WireGuard / Tailscale (recommended) | a private address for the coordinator, e.g. `https://10.x.x.x:8443` | no public exposure; SAN carries the private name/IP |
| Public DNS | `A` record, firewall allow on 8443, strict mTLS | exposed surface; restrict by source IP if possible |

Whichever you choose, the coordinator certificate must carry the **exact host** the
worker uses in `FLEET_CONTROL_URL`, because the client runs
`rejectUnauthorized: true`:

```
openssl x509 -in server.crt -noout -ext subjectAltName
# must contain DNS:<the host in FLEET_CONTROL_URL> (or IP:<addr> for an IP URL)
```

Egress from the site must permit TCP 8443 to the coordinator and DNS. If the
cluster enforces NetworkPolicy, it needs an explicit egress rule; if the path is a
VPN, the tunnel is the control.

## 4. Values to supply before the manifest

| # | Value | Format | Drives |
| --- | --- | --- | --- |
| 1 | Coordinator URL | `https://<host>:8443` | `FLEET_CONTROL_URL`, SAN |
| 2 | Agent(s) at this site | `three@ac02` | `FLEET_AGENT_ID`, `FLEET_SITES` |
| 3 | Namespace | `<namespace>` | every object's metadata, quota, RBAC |
| 4 | Egress | `TCP 8443 → <coordinator>`, DNS | NetworkPolicy |
| 5 | Image | `<registry>/…@sha256:<64 hex>` | container image |
| 6 | Identity Secret | `fleet-three` | volume mount |
| 7 | Resources | e.g. requests `100m/128Mi`, limits `500m/256Mi` | quota fit |
| 8 | Cluster type/version | k3s / kind / managed | API fields, probe style |

## 5. What the manifest will contain

- one `Deployment`, `replicas: 1` (two workers with the same CN would race for the
  same shard), `command: [node, backend/dist/cli/fleet-worker.js]`;
- env: `FLEET_CONTROL_URL`, `FLEET_AGENT_ID`, `FLEET_POLL_MS`, `FLEET_POLICY_FILE`,
  `FLEET_TLS_{KEY,CERT,CA}`, `POD_UID`, `POD_IP`;
- a site-local `ConfigMap` holding `policy.json` (hosts, ports, caps) — the worker
  validates every assignment against **its own copy**, so a mistaken coordinator
  cannot push an out-of-policy destination;
- the identity Secret mounted read-only;
- restricted security context: non-root 1000, `readOnlyRootFilesystem`,
  `allowPrivilegeEscalation: false`, all capabilities dropped, no service account
  token (`automountServiceAccountToken: false`);
- no Service and no inbound port.

## 6. Local dispatch must exclude remote agents

Implemented with this guide: `localAgents(sites, FLEET_LOCAL_SITE)` filters the
registry, and the control plane now creates Kubernetes Jobs **only** for agents
registered on its own site. Without it, a local Job would race the remote worker's
claim; `claim` is atomic, so whichever loses gets nothing and the remote site would
silently never emit traffic. `FLEET_LOCAL_SITE` is required wherever the control
plane runs.

## 7. Validation sequence once deployed

1. Worker logs one poll per interval and no TLS error.
2. `/api/fleet/status` lists the agent with `site: "ac02"` and a certificate status
   of `ok` or `expiring` — not `expired`.
3. A planned run assigns the shard, the worker executes it, and the run's
   `fleet.shards` carry `site: "ac02"` (M2.6 provenance).
4. Negative: an unregistered CN gets 403; a revoked leaf gets 403; a second worker
   with the same CN gets no work (the shard is already `RUNNING`).

## 8. What remains unverified

The PostgreSQL fleet tests (presence, `claimNext`, plan with sites) run only with
`DATABASE_URL_TEST`; they were written but not executed here. The worker's full TLS
round trip has been tested against the real mTLS server for the server side only.
No second cluster has ever been connected.

## 9. Registry and presence audit — 19 October 2026

Five findings from re-reading every consumer of the registry. Two were fixed:

**Fixed — the registry was duplicated.** `control.yaml` and `fleet.yaml` each carried
their own literal `FLEET_SITES`. They agreed by luck, not construction: the control
plane plans a shard's site while the fleet server records presence, so a drift
would have produced a shard labelled `ac02` and a presence row labelled `vps-lab`,
silently. Both Deployments now read one `fleet-registry` ConfigMap.

**Fixed — presence never went stale.** Nothing prunes `fleet_agent_presence_v1`, so
a decommissioned agent kept a row forever and `/api/fleet/status` could present it
as an agent that exists. Each certificate entry now carries `lastSeenAgoMs` and
`stale` (silence beyond 60 s), so "seen long ago" reads differently from "present".

Reported, not changed:

- **The agent ids are still the fixed triple.** `KubernetesJobs` accepts only
  `one|two|three` and validates Job names against `fleet-<uuid>-(one|two|three)`.
  A second site must therefore reuse one of those three identities — the envelope
  stays three agents in total, which is what `FLEET_LIMITS.maxAgents` and
  `splitBudget` already assume. More agents means raising a security bound, not
  editing a list.
- **Two different notions of "site".** The mission inventory (`devices.ts`) uses
  `siteId` for a device's location; the execution registry uses `site` for where an
  agent runs. Same word, different tables, different lifetimes. Keep them distinct
  in dashboards and do not join on the label.
- **The site is provenance, not authorisation.** The fleet server authorises by
  certificate CN; the site never gates a claim. A leaked agent certificate can
  claim that agent's shard from any network location — the mitigations remain
  revocation (`FLEET_REVOKED_CERT_SHA256`) and the fail-closed stop on lease loss,
  not the site label.
