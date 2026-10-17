# Synthetic bench acceptance — 17 October 2026

All 12 currently executable network-bench scenarios through reference level 5 completed once on the lab VPS. Real bounded UDP packets and TCP connections traversed ephemeral loopback components; this was not a simulated execution lifecycle. No public reflector, Fleet mission, production account, or production campaign was used.

## Scope and identity

- Application API and UI: exact deployed build 473, source `0e43cea0b5055806f71dbf337365b8dc4279f9ce`.
- Companion runner: `eb0aa26249965f9cddd421870dbc991348cb6d6a` on lab `31.31.74.187`.
- Isolated MemoryStore, legacy team development authentication, listener `127.0.0.1:18096`; no production data or authentication reused.
- First request submitted through Run Theater. Remaining requests dispatched sequentially by an acceptance driver through the normal bench API, using existing `processOne`/`runScenario` without parameter overrides. This does not prove a one-click ladder UI or production authenticated end-to-end operation.
- All default registered scenario rate/duration/factor caps retained. Reference DRS levels are catalogue labels, not achieved resilience levels. QUIC and reflection names denote synthetic shapes, not complete protocol implementations.

## Retained results

| Scenario                                                  | Reference | Execution | Observation           |   Received Mbit/s / TCP peak |
| --------------------------------------------------------- | --------: | --------- | --------------------- | ---------------------------: |
| [udp_dns_reflection](udp_dns_reflection.html)             |         3 | COMPLETED | UNMITIGATED_BASELINE  |                 3.220 Mbit/s |
| [udp_ntp_reflection](udp_ntp_reflection.html)             |         3 | COMPLETED | UNMITIGATED_BASELINE  |                 4.420 Mbit/s |
| [tcp_synflood](tcp_synflood.html)                         |         3 | COMPLETED | STATE_TABLE_SATURATED | 200 connections; 670 refused |
| [udp_maxpackets](udp_maxpackets.html)                     |         3 | COMPLETED | UNMITIGATED_BASELINE  |                 0.779 Mbit/s |
| [udp_ssdp_reflection](udp_ssdp_reflection.html)           |         3 | COMPLETED | UNMITIGATED_BASELINE  |                 2.854 Mbit/s |
| [tcp_maxpackets](tcp_maxpackets.html)                     |         3 | COMPLETED | STATE_TABLE_SATURATED | 300 connections; 850 refused |
| [udp_cldap_reflection](udp_cldap_reflection.html)         |         4 | COMPLETED | UNMITIGATED_BASELINE  |                 4.127 Mbit/s |
| [quic_init_pressure](quic_init_pressure.html)             |         4 | COMPLETED | UNMITIGATED_BASELINE  |                 0.139 Mbit/s |
| [tcp_conn_drain](tcp_conn_drain.html)                     |         4 | COMPLETED | STATE_TABLE_SATURATED | 200 connections; 268 refused |
| [udp_memcached_reflection](udp_memcached_reflection.html) |         4 | COMPLETED | UNMITIGATED_BASELINE  |                 4.761 Mbit/s |
| [udp_multivector](udp_multivector.html)                   |         4 | COMPLETED | UNMITIGATED_BASELINE  |                10.179 Mbit/s |
| [pulsewave_l34](pulsewave_l34.html)                       |         5 | COMPLETED | UNMITIGATED_BASELINE  |                 5.460 Mbit/s |

Nine UDP outcomes are unmitigated baselines with no scrubber. Three TCP outcomes show target state-table saturation. COMPLETED means execution finished, not protection passed. Received rates are observations, not offered load multiplied by amplification ratios. Packet loss and receiver pressure must not be interpreted as successful mitigation.

## Verification and outstanding defects

- 12 terminal COMPLETED records, 12 report endpoints returning successful HTML with matching run ID/status/outcome, 12 measured-lab coverage entries. Raw summaries, verdicts, audit and catalogue retained alongside this file.
- Theater visually showed REQUESTED → CLAIMED → COMPLETED and automatically populated all 12 result rows; screenshots retained. After reload, coverage correctly showed 12 measured, 12 covered, six never emitted.
- **Defect:** coverage totals remain stale during execution until page reload; polling updates runs but not coverage.
- **Defect:** individual TCP reports omit retained opened/accepted/refused/peak counters, while correctly retaining the saturation outcome. Use raw evidence or this acceptance table for those counters.
- **Defect:** aggregate report includes all 12 network coverage results, but its top summary remains HTTP-only (zero HTTP runs), and falsely states no weaknesses/targets held cleanly. It is unsuitable as a standalone synthetic campaign conclusion until corrected. `aggregate-final.html` preserves the actual output, not a corrected rendering.
- No native aggregate ladder campaign entity was exercised: sequential orchestration was provided by the acceptance driver. Production browser origin remained policy-blocked; no production browser acceptance claimed.

## Coverage limits

Six catalogue entries remain out of model and unexecuted: IP spoofing, UDP fragmentation, TCP fragmentation, TCP multivector, multiprotocol multivector and GRE. This is **12/12 supported synthetic scenarios**, not the entire official DRS framework through level 5. No physical DRS score or certification is established. Independent protection ingress, origin/user service and recovery evidence were not collected by this loopback bench.

## Artifacts

`runs.json`, `coverage.json`, `catalogue.json`, `audit.json`, per-scenario JSON summaries and HTML reports preserve the observations. `receipt.json` records source and scope. `theater-in-progress.png`, `theater-final.png`, `report-level5.png`, and AX snapshots document UI review. Production health was read only and source matched build 473; no application code, deployed release or production user data was changed during this acceptance.

Temporary acceptance application and workstation tunnel were stopped after evidence capture. The existing lab runner remains active.
