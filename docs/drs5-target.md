# DRS 5 capability target

Status: **target definition, 23 October 2026. Not delivered, not claimed.**

This document exists because older wording in the repository defined the product by its
current engine ("bounded HTTP generator, no raw sockets") rather than by the capability it
is meant to reach. That wording is accurate as a description of today's code and wrong as a
definition of the product. The invariant is the authorization model, not the transport.

## 1. What "DRS 5" means

Capability levels are defined by the DRS standard, not by this repository. The level 5
envelope used for planning is:

| Dimension               | Level 5 target |
| ----------------------- | -------------: |
| Throughput              |     500 Gbit/s |
| Packets per second      |       125 Mpps |
| Transactions per second |            1 M |
| Concurrent bots         |          5 000 |
| Maximum unavailability  |      5 minutes |
| Maximum added latency   |          1.5 s |

Reaching a volume does not establish a level: the corresponding vectors must be exercised
and service continuity measured. A campaign that generates 500 Gbit/s of the wrong vector
proves nothing.

## 2. What the product does today

Measured on the deployed control plane (`testdrs.trustena.lu`, build 542, commit `f3febfe`):

| Capability                       | Current value                                         | Source                         |
| -------------------------------- | ----------------------------------------------------- | ------------------------------ |
| Built-in generator ceiling       | 2 000 requests/s, 500 concurrent, 900 s               | `GET /health` → `hardCaps`     |
| Built-in sustainable path        | ~1 000 requests/s loopback, 0 failure                 | `docs/roadmap.md`, 19 Oct      |
| Fleet execution envelope         | 3 agents, 15 requests/s shared, 6 concurrent, 10–60 s | `FLEET_LIMITS`                 |
| Enrolled fleet nodes             | 1 (`ac02`, heartbeat only, no workload traffic)       | control-plane API, 23 Oct      |
| Packet-level generation          | none — no raw sockets, no spoofing                    | `backend/src/engine/README.md` |
| Worker image architecture        | single-arch (amd64)                                   | published digest, 23 Oct       |
| Independent external measurement | probe agent exists, not deployed at a second site     | `deploy/probe-agent`           |

The distance is not a tuning gap. It is roughly four orders of magnitude in transactions
and five in packets, and the missing piece is a different engine, not a higher cap.

## 3. The gap, by dimension

| Dimension         | Today                       | DRS 5                                 | What closes it                                           |
| ----------------- | --------------------------- | ------------------------------------- | -------------------------------------------------------- |
| L3/L4 volume      | none                        | 500 Gbit/s, 125 Mpps                  | packet engine (DPDK-class), not an HTTP client           |
| L7 transactions   | ~1 000 rps                  | 1 M TPS                               | horizontal clients + TLS session reuse; qualify per host |
| Bots / identities | bounded fleet agents        | 5 000 bots                            | registry is sized for it; execution is not               |
| Measurement       | control probe, loopback lab | 3 independent viewpoints              | external probe sites + target-side telemetry             |
| Evidence          | per-campaign, hashed        | per-vector, per-volume, per-dimension | retained run evidence at scale                           |
| Image portability | amd64 only                  | ARM64 hosts (RL300)                   | multi-arch build, digest-pinned per platform             |

## 4. What must change, and in what order

1. **Decide the engine.** Application-level generator (today) or packet-level generator
   (new). They are two products sharing an authorization and evidence layer. No hardware
   purchase is justified before this decision.
2. **Multi-arch images.** A published amd64-only image cannot run on the ARM64 RL300 pool.
   The build must emit `linux/amd64` and `linux/arm64`, pinned by digest.
3. **Fleet execution at volume.** One resident worker per site, claiming bounded shards,
   with local caps and a loss-of-control stop. The envelope is divided, never multiplied.
4. **Independent measurement.** A second and third probe site, plus target-side telemetry.
   A generator that measures itself is not evidence.
5. **Qualification runs.** Two machines with the real software, measured, before any
   capacity commitment. The machine count is derived from measured throughput, not the
   reverse.

## 5. What this document does not do

It does not claim DRS 5. It does not enable raw sockets, spoofing or amplification. The
safeguards in `AGENTS.md`, `backend/src/config/limits.ts` and the
target/approval/kill/audit policy remain mandatory, and a packet engine would be added
**under** them, not around them.

## 6. Reporting rule

A report must state: vectors exercised, volume requested, volume emitted, volume received,
measurement viewpoints, and which dimensions were not covered. A volume without a received
measurement is a claim, not a result.
