# Security model & scope

This tool is a **defensive control plane** for internal resilience testing. Its
design places safeguards at every step and **deliberately excludes** any
offensive capability.

## Technical safeguards

| Safeguard   | Mechanism                                                                                     | Where                                        |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Allowlist   | Target **and** probe must be in `ALLOWED_TARGETS`; otherwise rejected                         | `campaigns/service.ts`, `engine/loadTest.ts` |
| Attestation | `authorized:true` required at creation                                                        | `campaigns/service.ts`                       |
| Hard caps   | `maxRps ≤ 2000`, `concurrency ≤ 500`, `duration ≤ 900 s`                                      | `HARD_CAPS`                                  |
| Approval    | PENDING→APPROVED/REJECTED workflow, **separation of duties**, 24 h validity, reason on reject | `campaigns/service.ts`                       |
| Kill switch | Auto (>30 s unavailable) / manual / time-based                                                | `probe/probe.ts`, `runner.ts`                |
| Tagging     | `X-WEDOS-TEST: <campaignId>:<ts>` header on every request                                     | `runner.ts`                                  |
| Protocols   | `http`/`https` only                                                                           | URL validations                              |

## Network / operational safeguards

- API/UI on **loopback only** (`HOST=127.0.0.1`); access via SSH tunnel.
- No public exposure; no application-level authentication → never bind on
  `0.0.0.0`.
- Deployment via a **read-only** deploy key.

## What is NOT implemented (by design)

The **only** load vector is a **bounded application HTTP generator** (GET/POST,
rate-capped, allowlisted target). The following are **out of scope** and absent
from the code:

- **L3/L4 volumetric**: UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS
  flood, DNS/NTP/SSDP/CLDAP reflection/amplification, Smurf.
- **L7 exhaustion**: Slowloris, RUDY, cache-bypass, brute-force, WebSocket
  flood, GraphQL abuse, XML bomb, “browser botnet”.
- Any generation at an unbounded rate or toward a target outside the allowlist.

These techniques serve to **saturate** a service, not to **measure** its
resilience in a controlled way. A contribution adding them falls outside this
repository's scope and must not be merged.

## Usage responsibility

The allowlist and attestation are technical barriers, not proof of
authorization. The operator remains responsible for only targeting systems they
own or for which they hold a written authorization. See
[SECURITY.md](../SECURITY.md).
