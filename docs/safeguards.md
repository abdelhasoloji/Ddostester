# Security model & scope

This tool is a **defensive control plane** for internal resilience testing. Its
design places safeguards at every step and **deliberately excludes** any
offensive capability.

## Technical safeguards

| Safeguard   | Mechanism                                                                                                                                            | Where                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Allowlist   | Target **and** probe must be in `ALLOWED_TARGETS`; otherwise rejected                                                                                | `campaigns/service.ts`, `engine/loadTest.ts`            |
| Attestation | `authorized:true` required at creation                                                                                                               | `campaigns/service.ts`                                  |
| Hard caps   | `maxRps ≤ 2000`, `concurrency ≤ 500`, `duration ≤ 900 s` — defined **once** and frozen; the frontend reads them from `/health`, never hardcodes them | `config/limits.ts` (`HARD_CAPS`), exposed via `/health` |
| Approval    | PENDING→APPROVED/REJECTED workflow, **separation of duties** (author≠approver **and** approver≠executor), 24 h validity, reason on reject            | `campaigns/service.ts`, `app.ts`                        |
| Kill switch | Auto (>30 s unavailable) / manual / time-based                                                                                                       | `probe/probe.ts`, `runner.ts`                           |
| Tagging     | `X-WEDOS-TEST: <campaignId>:<ts>` header on every request                                                                                            | `runner.ts`                                             |
| Protocols   | `http`/`https` only                                                                                                                                  | URL validations                                         |

## Network / operational safeguards

- API/UI on **loopback only** (`HOST=127.0.0.1`); access via SSH tunnel.
- No public exposure; no application-level authentication → never bind on
  `0.0.0.0`.
- Deployment via a **read-only** deploy key.

## What is NOT implemented (by design)

The **control plane** (`backend/` + `frontend/` — the deployed product) has a
single load vector: a **bounded application HTTP generator** (GET/POST,
rate-capped, allowlisted target). The following are **out of scope** and absent
from the control plane:

- **L3/L4 volumetric**: UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS
  flood, DNS/NTP/SSDP/CLDAP reflection/amplification, Smurf.
- **L7 exhaustion**: Slowloris, RUDY, cache-bypass, brute-force, WebSocket
  flood, GraphQL abuse, XML bomb, “browser botnet”.
- Any generation at an unbounded rate or toward a target outside the allowlist.

These techniques serve to **saturate** a service, not to **measure** its
resilience in a controlled way. A contribution adding an attack vector to the
control plane falls outside this repository's scope and must not be merged.

## The synthetic network lab (`lab/`)

The repository also ships an **optional, closed research lab** that reproduces
the _traffic shape and measurement problem_ of UDP amplification for defensive
study — **not** a usable attack tool, and **not** part of the control plane.
Its safety rests on concrete, code-level properties:

- **No source-IP spoofing** — it uses ordinary UDP sockets and the reflection
  target is fixed by configuration, never read from a packet's source address,
  so it cannot reflect off third parties (the defining trait of a real
  reflection attack).
- **No real reflector protocols** — the protocol is a synthetic JSON message; no
  DNS/NTP/SSDP/Memcached service is implemented. The named profiles
  (`generic`/`dns`/`ssdp`/`ntp`/`memcached`) are only byte/packet _shape_ presets
  used to study detection per traffic profile, not protocol implementations.
- **Hard caps** on byte factor, response size, packet factor, generator PPS and
  duration; oversized requests are clamped.
- **Network isolation** — the provided `docker compose --profile network-lab`
  runs on an `internal: true` Docker network with **no published host ports**,
  and the host guards target only an RFC1918 lab prefix.

It exists to validate filtering, telemetry, detection delay, BAP and
availability in a **closed** environment. It must **never** be attached to a
production or public network, and running its components outside the isolated
lab network is unsupported. See [network-lab.md](./network-lab.md).

## Usage responsibility

The allowlist and attestation are technical barriers, not proof of
authorization. The operator remains responsible for only targeting systems they
own or for which they hold a written authorization. See
[SECURITY.md](../SECURITY.md).
