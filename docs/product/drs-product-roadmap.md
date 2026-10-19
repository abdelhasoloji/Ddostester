# DRS product roadmap — zeroBS-class platform

Working goal: a product that measures **DRS 3.00.00** the way zeroBS does — a cloud load
plane, a client dashboard, and a defensible report — built from this codebase rather than
from scratch. Prototype first; full review at the end.

The normative core already exists and is the expensive part: 131 archived vectors with
hashes, 140 ambiguities, conservative scoring with bounds, a proof chain, and a frozen
plan. What is missing is the **load plane** and the **product shell**.

## What zeroBS actually sells

From their public material: volumetric up to 100 Gbps / 100 Mpps, L7 up to 10 M RPS,
50 locations, ~100 000 dedicated IPs, botnet simulation (10 000 IPs), client dashboard,
monitoring export, replay, and attack modes (carpet bombing, timed pulses). The DRS is
the measurement framework layered on top.

That sets the bar and also the honest split: **Kubernetes gives RPS and parallelism, not
Gbps and IP diversity.** A pod can push requests; it cannot conjure transit capacity or a
routable /20.

## Architecture

```
control plane (this app)          load plane (Kubernetes)         evidence plane
────────────────────────          ──────────────────────         ──────────────
DRS plan, freeze, approve   ───▶  site workers, one pod per     probes, target logs,
budget envelope, admission        "bot", per-pod capacity       edge telemetry
proof chain, scoring        ◀───  per-pod measurements      ◀───  baseline, under-load
report, dashboard, replay         autoscaled to the envelope
```

The load plane reports what it actually emitted. The control plane never assumes a pod
produced its nominal rate: the envelope is **derived from measured capacity**, and the
report states measured delivery.

## Capacity model (the linchpin)

Today `FLEET_LIMITS` is a constant (15 rps, 6 workers, 3 agents, 60 s). It makes every
DRS level unreachable by construction, including level 1 (500 tps, 10 bots).

Replace the constants with a derived envelope:

```
capacity      = Σ over agents ( measuredTps[agent] ) × derating        (derating 0.8)
envelope      = min( signedScope, capacity, SERVICE_CEILING )
```

- `measuredTps` comes from a calibration run per agent profile, recorded with its
  conditions (CPU, latency to target, TLS on/off). An agent with no calibration has
  capacity 0 and is not admitted.
- `signedScope` is the per-test authorization: target(s), max tps, max concurrency,
  duration, window, abort criteria. It is the binding constraint, not the constant.
- `SERVICE_CEILING` is a deployment setting (default: the current hard cap) so nothing
  escalates silently; the prototype raises it deliberately.

`SERVICE_CEILING` is also what makes a level reachable or not: with 200 pods measured at
5 000 tps each and derating 0.8, capacity is 800 000 tps — enough for the HTTP L4 line.
Without those pods, the same code reports the gap instead of pretending.

## Milestones

**P1 — Capacity and admission (now).**
`capacity.ts`: measured-capacity model, envelope derivation, per-level reachability.
No behaviour change until `SERVICE_CEILING` is configured. Tests cover the arithmetic
and the refusals (no calibration, scope above ceiling, scope above capacity).

**P2 — Kubernetes load plane.**
Workers as a Deployment scaled by the envelope, one pod per bot, per-pod self-calibration
at start, aggregate reporting to the coordinator. The existing Job-based path stays for
single runs; the Deployment path is the product path.

**P3 — Product shell.**
DRS plan builder (level, vectors, scope, services, injection point) → freeze → approve →
execute → live dashboard → report. Retire the legacy campaign form from the primary path.

**P4 — Evidence completeness.**
Assertion parity on high-rate engines (or a target-side witness transaction), a
post-exposure observation window for `persistence` and `max_out`, and measured source
diversity (IP/ASN) in the proof.

**P5 — Realism and modes.**
UA/TLS/behaviour profiles, carpet bombing and timed pulses, replay of a recorded run.

## Safety that stays

Authorization, target allowlist, signed scope, kill switch, audit, auto-pause on a downed
origin, and the rule that a verdict can never pass a vector whose requirement was not
reached. The ceiling moves; the guardrails do not disappear.

## What we still cannot claim

Volumetric (Gbps/pps) and botnet IP diversity need transit capacity and routable
addresses. A Kubernetes cluster behind one uplink can produce high RPS and many
connections, and must then state its real numbers — not inherit zeroBS's.

## Delivered

| Capability                                                                      | Where                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Requirement gaps as data (load, sources, persistence) with required vs recorded | `modules/drs/scoring.ts`, DRS report                                               |
| Measured-capacity envelope, level reachability, service ceiling                 | `modules/drs/capacity.ts`, `config/service-ceiling.ts`                             |
| Calibration registry (validated, audited, PostgreSQL + memory)                  | `modules/drs/calibration.ts`, migration 9                                          |
| Client dossiers, capacity screen, DRS workspace, replay, verdict + gaps inline  | frontend pages                                                                     |
| Plan authoring with frozen budgets and exclusions                               | `POST /api/drs/plans`                                                              |
| Measured execution loop with sealed evidence                                    | `probe-collector.ts`, `engine-generator.ts`, `POST /api/campaigns/:id/drs/execute` |
| Configurable baseline floor (default 300 s)                                     | `config/drs-baseline.ts`                                                           |
| Kubernetes load plane renderer + offline validator                              | `deploy/kubernetes/load-plane/`                                                    |
| CI/CD: deploy 11 min → 1 min 30 s, superseded runs cancelled                    | `deploy/update.sh`, `.github/workflows/ci.yml`                                     |

Verified end to end on the development server: plan → 202 → baseline → real exposure →
sealed proof (generator + user points, 22/22 verified transactions) → FINAL_REPORT in 16 s
→ report `PARTIAL` with three unmet requirements stated with their numbers.

## Remaining before a certifiable DRS test

1. **Independent entry/origin witness** — the only path from PARTIAL to a measured verdict.
   Requires target-side telemetry ingestion and sealed `entry`/`origin` points.
2. **Source diversity** — DRS vectors ask for hundreds to thousands of independent bots; the
   fleet admits what it can calibrate, and the gap must stay stated until the fleet is real.
3. **Volumetric capacity** — `bps`/`pps` are out of reach of an application load plane behind
   one uplink; that requirement stays unmet by design and is reported as such.
4. **Deployed Kubernetes plane** — the manifests are rendered and validated offline but have
   not been applied to a live cluster.
5. **Certification** — explicitly out of scope: `certification: false` is part of every
   assessment.
