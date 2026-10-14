# Persistent Fleet mission contract

The current application orchestrates three already provisioned simulated IoT workers. The mission adapter is distinct from the older Kubernetes Job adapter. `FLEET_MISSIONS_ENABLED=1` enables persistent missions; production retains `FLEET_ENABLED=0` for the older Job path.

## Control plane → worker

A campaign binds exact agent IDs and their site metadata, target URL/origin, deadline, shared rate/concurrency budget and duration. Target resolution follows the campaign's explicit URL and endpoint plan; an IoT/burst name does not select Fleet by itself. The selected execution source and approved origin must be explicit.

Workers poll authenticated commands, prepare readiness, start bounded HTTP GET work, send monotonic heartbeats/progress and return final counters. Global budgets are divided across selected workers, not multiplied by their count. The parent campaign retains its complete observation window. A changed origin, stale authorization, expired identity, lost deadline or user stop must stop/refuse work under the implemented protocol.

## Worker → control plane

Receipts preserve agent/site identity, timing, attempted/successful requests, errors and stop status. A missing heartbeat is not an acknowledgment that a process stopped. Unknown metrics stay unknown. Failures produce a public diagnostic reference; detailed server errors remain private.

Run Theater reads live progress and shows the compact agent count. Fleet exposes per-agent evidence and downloads. API reads and mutations use server capabilities, not UI labels. Archived campaigns cannot dispatch, and simulation campaigns are rejected by physical runners even through direct calls.

## Kubernetes → worker

Kubernetes provisions constrained Pods, identities, network policy and resources. It is not the score authority. Current Pods request 50m CPU/128Mi, limits 250m/256Mi. Certificates/keys, persistent sequence state and target restrictions are deployment prerequisites. No UI-driven Kubernetes provisioning or autoscaling is implemented.

The older coordinator/Job path has its own mTLS, fencing, leases and durable-evidence contracts; it must not be mistaken for the active three-worker mission deployment. Both share central safety limits in `backend/src/config/limits.ts`.

## Evidence integration

Physical assessment baselines have a 300-second minimum and bounded extension to 600 seconds. Worker preparation performs a short freshness check after the long baseline. Successful and failed diagnostic runs attach their existing evidence and finalize a DRS report without claiming a qualified vector PASS. Full-standard physical collector ports remain unbound; see [DRS plans and scoring](drs-engine.md).

Existing low-rate receipts and acknowledged stops establish the implemented path, not a throughput certification. Source diversity is measured at the tested entry; three private IPs behind one public egress remain one public source. Current limits and observations are in [current setup](current-setup.md).
