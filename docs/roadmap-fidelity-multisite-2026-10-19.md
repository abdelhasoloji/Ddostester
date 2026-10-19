# Delivery fidelity and multi-site fleet — roadmap

Status: **source plan, 19 October 2026.** M1.1 and M1.4 are implemented in source
and covered by tests; nothing here is deployed, and no traffic limit is raised.
This document plans work; it is not a delivery or qualification receipt.

## Premises this plan corrects

- The synthetic generator is `engine/loadTest.ts` plus the `agents/*` adapters.
  `modules/drs/orchestrator.ts` is the DRS assessment state machine: it dispatches
  through `DrsGeneratorPort` and refuses any vector outside `…51002`
  (`orchestrator.ts`, "Unsupported physical vector"). Optimising `orchestrator.ts`
  would not add throughput.
- `DRS 5` in `modules/playbooks/playbooks.ts` is a severity line (500–1,000 rps),
  not a generator mode. DRS scoring belongs to the published standard
  (`standards/drs/3.00.00/`); a generator cannot "reach" a score.
- The binding constraint on DRS execution is the shared Fleet envelope
  (`FLEET_LIMITS`: 15 rps, concurrency 6, 3 agents, 60 s), checked by
  `orchestrateDrs`. The built-in ceiling (~150 rps / 300 concurrent, measured) is
  secondary.
- `HARD_CAPS` in `config/limits.ts` is a frozen, server-enforced security
  boundary. This plan does not weaken it, and no task below is a rate-limit
  bypass.

## Phase 1 — delivery fidelity inside the current envelope

The problem is not the size of the envelope; it is that a run can be graded on
traffic that never arrived, and that the generator degrades its own measurement
while reporting it.

| Milestone | Change                                                                                                                                                                                                                                                       | Files                                                                      | Impact / effort | Status             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------- | ------------------ |
| **M1.1**  | Streaming latency recorder: O(1) ingest into a `Float64Array` + histogram; live ticks served from buckets instead of copying and sorting every sample each second; final percentiles still exact (one sort at settle).                                       | `engine/stats.ts`, `engine/loadTest.ts`, `test/latency-recorder.test.ts`   | high / low      | **source, tested** |
| **M1.4**  | Refuse silent under-delivery: a built-in run above its measured ceiling, with no out-of-process engine available and no `calibrate: true`, fails with an actionable error instead of grading traffic that never arrived.                                     | `modules/campaigns/engine-route.ts`, `app.ts`, `test/engine-route.test.ts` | high / low      | **source, tested** |
| M1.2      | Smooth pacing: the 1-second window that released `maxRps` permits at each boundary (then idled) becomes one global pacer claiming the next permit on an ideal clock, so requests are spaced at `1000/maxRps` and a late timer never causes a catch-up burst. | `engine/loadTest.ts`, `test/engine-pacing.test.ts`                         | medium / medium | **source, tested** |
| M1.3      | Per-request cost: the per-request `setTimeout` + `AbortSignal.any` pair becomes one sweeper (20 ms) over a deadline map plus a single kill listener aborting every in-flight controller.                                                                     | `engine/loadTest.ts`                                                       | low / medium    | **source, tested** |
| M1.5      | Extend engine routing (or refuse at authoring) for shapes still pinned to the built-in engine (`dataset`, body assertion) above the ceiling, so the UI cannot offer an undeliverable configuration.                                                          | `modules/campaigns/engine-route.ts`, `service.ts`, frontend catalogue      | medium / low    | planned            |

Order: M1.1 → M1.4 → M1.2 → M1.3 (all done) → M1.5.

Acceptance for M1.1: event-loop lag during a 150 rps / 300 concurrent run stays
below the existing guard (`EVENT_LOOP_LAG_GUARD_MS`, `modules/reports/confidence.ts`),
and final p50/p95/p99 are unchanged for the same traffic.

Acceptance for M1.3: honest bound — per-request abort bookkeeping drops from
≈3.9 µs to ≈0.2 µs (measured, 22×), i.e. ≈0.6 ms/s → ≈0.03 ms/s at 150 rps and
≈8 ms/s → ≈0.4 ms/s at the 2,000 rps ceiling. The gain is allocation discipline
(no 2,000 timers/s and no composed signals), not a headline CPU win; timeouts are
now honoured within 20 ms.

Acceptance for M1.2: a 100 rps / 1 s run reaches ~100 requests with no 100 ms
window above ~1/3 of the old burst (measured: 16 per 100 ms, 100 requests,
100.5 rps across the ten 100 ms buckets), and the same spacing holds across a
window boundary.

## Phase 2 — multi-site fleet at constant aggregate

Goal: deliver an already-authorized aggregate faithfully by splitting it across
sites, **not** to increase the aggregate. The sum of every site's budget stays
≤ `HARD_CAPS`, so the blast radius does not change; only delivery accuracy does.
This matches the existing invariant that a budget is never multiplied.

| Milestone | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Files                                                                                                                                                                                                                 | Depends on                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **M2.0**  | Scope decision, recorded below: one authorized aggregate per run; a site is admitted by a human through the identity registry; each site enforces the allowlist locally and fails closed.                                                                                                                                                                                                                                                                                                                          | `docs/`                                                                                                                                                                                                               | —                              |
| **M2.1**  | `FleetExecutor` port extracted: `create`/`remove`/`evidence`/`close`, with `KubernetesJobs` as the local implementation and `createFleetExecutor(env)` as the factory. `FleetHttpAgent` accepts an injected executor. The Kubernetes-specific namespace, digest-pinned image and `https://lab-fleet:8443` URL now live behind the port instead of being constructed inline. No remote executor exists yet.                                                                                                         | `modules/fleet/executor.ts` (new), `modules/fleet/kubernetes.ts`, `agents/fleet.ts`, `test/fleet-executor.test.ts`                                                                                                    | M2.0 — **source, tested**      |
| M2.2      | Resident remote worker, **outbound only**: `cli/fleet-worker.ts` polls `GET /internal/fleet/work`, validates each assignment against its own policy file, executes it locally and reports. The loop is a tested port (`modules/fleet/worker.ts`) with explicit failure policy; the one-shot `fleet-agent` now shares the same `agent-client`. Remaining: a per-site deployment manifest (coordinator address, namespace and egress are site-specific and cannot be verified here).                                 | `cli/fleet-worker.ts` (new), `modules/fleet/worker.ts` (new), `modules/fleet/agent-client.ts` (new), `cli/fleet-agent.ts`, tests                                                                                      | M2.1 + A1 — **source, tested** |
| M2.3      | Registry keyed by site: `FLEET_AGENT_IDS` is replaced by `FLEET_SITES` (`agent@site`), parsed and validated by `parseFleetSites` (one agent per entry, at most `maxAgents`). The CN stays the identity; the site is recorded in `fleet_agent_presence_v1` and surfaced per certificate in `/api/fleet/status`. Server-certificate SANs for a remote site are documented in `fleet-certificates.md` but emitted by the operator's PKI script, not by this code. Certificate renewal remains manual (14-day leaves). | `modules/fleet/sites.ts` (new), `modules/fleet/server.ts`, `modules/fleet/coordinator.ts`, `modules/fleet/status.ts`, `cli/fleet-server.ts`, `deploy/kubernetes/base/fleet.yaml`, `docs/fleet-certificates.md`, tests | M2.2 — **source, tested**      |
| **M2.4**  | Aggregate budget enforcement: `authorizedEnvelope()` fixes the one envelope (`min(HARD_CAPS, FLEET_LIMITS, site policy)`), and `assertAggregateBudget()` proves after division that the shards conserve the requested aggregate exactly and fit it. `plan()` refuses otherwise, in addition to the existing single-run advisory lock.                                                                                                                                                                              | `modules/fleet/contract.ts`, `modules/fleet/coordinator.ts`, `test/fleet-contract.test.ts`                                                                                                                            | M2.0 — **source, tested**      |
| M2.5      | Network path: a WireGuard mesh (recommended — keeps private addresses, no public exposure) or a public endpoint with a dedicated SAN, strict mTLS and an ingress policy. Today agent egress is restricted to in-namespace `app: lab-fleet`.                                                                                                                                                                                                                                                                        | `deploy/kubernetes/base/policy.yaml`, `docs/fleet-certificates.md`, deployment manifests                                                                                                                              | M2.2                           |
| M2.6      | Per-site evidence: `fleet_shards_v1.site` records the originating site at plan time from the same registry; `snapshot()`, `inspectFleet` and the run's fleet shards carry it, so a report names where load was emitted. The site is provenance only — it is deliberately **not** added to the signed assignment, whose key set is strict.                                                                                                                                                                          | `modules/fleet/coordinator.ts`, `modules/fleet/summary.ts`, `modules/fleet/status.ts`, `agents/fleet.ts`, `deploy/kubernetes/base/control.yaml`, tests                                                                | M2.2 — **source, tested**      |
| M2.7      | Measured-DRS track (separate): a distributed generator does not produce a DRS result. Each measurement role needs independently qualified collectors, per `docs/drs-engine.md`.                                                                                                                                                                                                                                                                                                                                    | `modules/drs/*`, collector integration                                                                                                                                                                                | M2.6                           |

### M2.0 — scope decision (recorded)

- **One authorized aggregate per run.** The envelope is
  `min(HARD_CAPS, FLEET_LIMITS, site policy)`, computed once by `authorizedEnvelope()`.
  Adding sites divides that number; it never raises it.
- **A site is admitted by a human** through the identity registry (M2.3). The
  coordinator never enrolls a site by itself, and a site cannot propose its own budget.
- **Each site enforces the target allowlist locally and fails closed.** A site that
  cannot verify the allowlist must not emit traffic.
- **One fleet run at a time, globally.** The existing advisory lock plus active-deadline
  check in `plan()` is preserved; M2.4 only adds the post-division proof.

### M2.4 — what the code now enforces

`modules/fleet/contract.ts`:

- `authorizedEnvelope(policy)` — the single envelope for a run.
- `assertAggregateBudget(requested, shards, envelope)` — shards must (a) conserve the
  requested aggregate exactly, (b) fit the envelope, (c) number no more than
  `FLEET_LIMITS.maxAgents`, (d) each be a positive integer.

`coordinator.plan()` calls it after `splitBudget()`, so a distributed executor that
receives one shard cannot mint a new budget. Tests include the multi-site failure mode
explicitly — three sites each handed the full aggregate are refused — plus a fast-check
property over every valid (rate, concurrency, agents) combination. The existing
PostgreSQL suite is unaffected: `15 rps / 6 / 3 agents` is accepted, `18 rps` is still
refused with an "Aggregate …" error.

### B — certificate presence (prerequisite for M2.3)

A remote site whose leaf expires dies silently: the mTLS certificates last 14 days
and renewal is a manual operator action. The fleet server now records
`agent_id`, the certificate's own `valid_to` and `last_seen` in
`fleet_agent_presence_v1` on every authenticated request, and `inspectFleet`
exposes it through `/api/fleet/status` with a pure `certificateHealth()` helper
(`ok` / `expiring` at seven days / `expired`). No key material is stored, and a
failed presence write never refuses an otherwise valid request. The table is
created by the existing advisory-locked `init()`; a status read tolerates its
absence, so an unmigrated node reports no certificates instead of failing.

### A1 — work discovery (no second queue table)

The plan originally proposed a `fleet_work_v1` table. That would duplicate
`fleet_shards_v1`, where the work already lives as `PENDING` rows keyed by
`agent_id`. Instead the coordinator gained `claimNext(agentId)`: it finds the one
active run, then delegates to the existing row-locked `claim(runId, agentId)`.
`GET /internal/fleet/work` exposes it over the same mTLS identity check as the
other routes. A resident site worker therefore learns its shard without knowing
the runId, and a second poll cannot receive the same work twice because the shard
is already `RUNNING`.

Trade-off accepted: dispatch latency is one poll interval (~1 s), which is
irrelevant at the fleet's 15 rps envelope.

### M2.2 — worker failure policy

The loop (`runWorkerLoop`) is written against a three-method port (`poll`,
`execute`, `report`) so its behaviour is testable without TLS, a coordinator or a
database:

- a transient poll failure is retried; only a run of consecutive failures stops
  the worker (default 5, 6 in `fleet-worker`), so a coordinator restart does not
  kill every site;
- an execution failure is reported as `FAILED` and never retried — a second
  attempt would multiply the budget;
- a failed report is tolerated: the shard's lease expires and the coordinator
  records it as `LOST`, which is the existing fail-closed path.

The worker also re-validates every assignment against its own trusted policy file
(`readAgentPolicy`, 15 rps / 6 / 60 s, explicit hosts and ports). A compromised or
mistaken coordinator therefore cannot push an out-of-policy destination: the
site's policy is authoritative where the traffic is emitted.

### M2.3 — what is code and what is certificate

The registry is code: `parseFleetSites('one@vps-lab,two@vps-lab,three@ac02')` is now the single
source of agent→site, and `buildFleetServer` takes that registry instead of a bare id list. A
registry with a duplicate agent, a malformed id, or more entries than
`FLEET_LIMITS.maxAgents` refuses to start — the same bound the budget split uses. The site is
recorded with the agent's certificate presence and appears in `/api/fleet/status`.

The SAN is **not** code. Whether the coordinator certificate contains the DNS name a remote site
dials is a property of the certificate issued by the operator's CA script. The requirement and a
verification command are documented in `fleet-certificates.md`; the code cannot enforce or repair it.

### M2.6 — provenance without widening the contract

The assignment hash covers a strict, fixed key set (`validateAssignment` refuses
unknown fields), so adding `site` to the assignment would have silently changed a
signed artifact. Instead the site lives in `fleet_shards_v1.site`, written once at
plan time from the validated registry (`parseFleetSites`). It then flows through
`snapshot()` → `summarizeFleet()` → the run's `fleet.shards`, and through
`inspectFleet()` for live status.

Historical evidence predating this change has no `site` field: `FleetShardEvidence.site`
is optional, and a test asserts it stays absent rather than being back-filled with a
guess.

## What this plan does not do

- It does not raise, bypass or reinterpret `HARD_CAPS`, `FLEET_LIMITS`, the target
  allowlist or the approval/kill/audit policy.
- It does not add amplification, source spoofing or reflected traffic. Per
  [boundary-and-lab](boundary-and-lab.md), private pods behind one public egress
  do not establish distributed Internet-source diversity, and no multiplier may
  inflate received traffic.
- It does not make a DRS level pass. Scoring needs independent evidence, not a
  larger generator.

## Sequence

1. M1.1, M1.4 — done in source (fidelity: stop grading traffic that never arrived).
2. M1.2, M1.3 — remove the remaining self-inflicted measurement cost.
3. M2.0, M2.4 — fix the aggregate rule before any second site exists.
4. M2.1, M2.2 — remote executor and outbound worker.
5. M2.3, M2.5, M2.6 — identity per site, network path, evidence provenance.
6. M2.7 — measured-DRS qualification, which is the only track that can claim a
   DRS result.

See [engine strategy](engine-strategy.md), [fleet management](fleet-management.md),
[DRS engine](drs-engine.md) and [boundary and lab](boundary-and-lab.md).
