# WEDOS ShieldTest Network Lab (safe synthetic amplification)

This lab reproduces the **traffic shape** and the measurement problem of UDP
amplification so that filtering, telemetry, detection delay and availability can
be studied in a closed environment. It is a **measurement model, not an
amplifier**: there is no IP spoofing, no real DNS/NTP/SSDP/memcached service, no
public reflector, and no Internet-routable target anywhere in it.

## Topology

```text
generator (.10) -> synthetic-reflector (.50) -> [ scrubber (.60) ] -> target (.99)
                         |                              |
                         +-- byte factor (N)            +-- forwards up to CEILING_PPS;
                         +-- packet factor (P)              once THRESHOLD_PPS is sustained
                                                            past DETECTION_DELAY, drops the excess
```

The scrubber is **optional**: by default the reflector hits the target directly.
Set `LAB_REFLECTOR_TARGET=192.168.100.60` and `LAB_REFLECTOR_TARGET_PORT=9005` to
route through it and study detection/mitigation (see the mitigation section below).

All services are attached to the Docker network `shieldtest_lab`, configured with
`internal: true`. Docker therefore provides no default external routing for this
network.

## Mitigation node (scrubber)

The scrubber models a filtering appliance and makes the **detection/mitigation problem measurable**:

- it measures the incoming rate and, once `THRESHOLD_PPS` is sustained past
  `DETECTION_DELAY_SEC`, **engages mitigation** — forwarding only up to
  `CEILING_PPS` and dropping the excess;
- it classifies packets by their payload `type`, so it reports **collateral**
  (`collateral_pct` = share of dropped packets that were legitimate);
- Prometheus (`METRICS_PORT=9105`): `shieldtest_scrubber_received_total`,
  `_forwarded_total`, `_dropped_total`, `_dropped_legit_total`, `_mitigating`,
  `_detection_delay_seconds`, `_collateral_pct`.

Like every lab node, it only forwards toward a **private/loopback** target (hard
gate) and generates no traffic of its own.

## Closed loop with the control plane (measured WRS)

The lab feeds the control plane by **measurement**, never by generating its
traffic. Two lab endpoints speak the exact JSON the control-plane pull connectors
expect:

- scrubber `GET /protection` → `{ detectionTimeSec, mitigationTimeSec, source }`
  — point `PROTECTION_METRICS_URL` at it so a run's WRS uses **measured** D/M;
- target `GET /telemetry` → `{ nicRxMbps }` — point
  `TARGET_TELEMETRY_METRICS_URL` at it to correlate host load to the run.

So a bounded ShieldTest HTTP campaign against the lab target, run while the UDP
amplification + scrubber are active, yields a **measured WRS end to end** — the
control plane _measures_ the amplification, it never _produces_ it.

## Rate shapes & legitimate background

Independently of the `PROFILE` (which sets the amplification factors — see
"Synthetic protocol profiles" below), the generator supports a `SHAPE`
(`constant` | `ramp` | `wave` | `burst`) that modulates the send **rate over
time** within the base `PPS` cap — useful to study how detection reacts to a ramp
vs. a burst. The optional `lab-legit` service sends benign, never-amplified
traffic (`MODE=legit`) straight to the scrubber, so
`shieldtest_scrubber_collateral_pct` shows whether mitigation harms good traffic.

## Start

```bash
POSTGRES_PASSWORD=dev docker compose --profile network-lab up -d lab-target lab-reflector
```

Run one bounded test:

```bash
PROFILE=dns PPS=20 DURATION_SEC=10 \
POSTGRES_PASSWORD=dev docker compose --profile network-lab run --rm \
  -e PROFILE -e PPS -e DURATION_SEC lab-generator
```

Inspect metrics:

```bash
docker compose logs --since=1m lab-reflector lab-target
```

The reflector prints `bap = outputBytes / inputBytes` and
`packetAmplification = outputPackets / requests`. The target prints cumulative
packets/bytes and average PPS/BPS.

## Synthetic protocol profiles

`PROFILE` selects a synthetic traffic _shape_ that approximates the published
amplification behaviour of a real protocol. A profile is only a pair of preset
factors plus a label — it does **not** implement the protocol and never contacts
a real service. `referenceBap` is the documented real-world figure (US-CERT
TA14-017 and public memcached reports) kept for comparison; the **effective** BAP
the lab produces is whatever survives the hard caps, and that is what the metrics
report.

| PROFILE     | byte factor | packet factor | referenceBap | shape modelled            |
| ----------- | ----------- | ------------- | ------------ | ------------------------- |
| `generic`   | 10          | 1             | 10           | baseline synthetic        |
| `dns`       | 40          | 1             | 54           | DNS ANY-style response    |
| `ssdp`      | 30          | 1             | 31           | SSDP/UPnP discovery reply |
| `ntp`       | 100         | 6             | 557          | NTP monlist-style burst   |
| `memcached` | 100         | 10            | 10000        | memcached stats flood     |

`FACTOR` and `PACKET_FACTOR` still work as explicit overrides of a profile's
presets. Every value is clamped at runtime by `MAX_FACTOR`, `MAX_RESPONSE_BYTES`
and `MAX_PACKET_FACTOR`, so no profile — and no crafted request — can exceed the
lab's caps. The reflector breaks its metrics down per profile (see below); an
unrecognised label is bucketed as `other`, so untrusted input never widens the
metric cardinality nor reaches the exposition text.

## Amplification model

The reflector models two independent, bounded dimensions of amplification:

- **Byte amplification** (`FACTOR`, capped by `MAX_FACTOR` / `MAX_RESPONSE_BYTES`):
  each response is grown to `min(MAX_RESPONSE_BYTES, requestBytes * FACTOR)`.
- **Packet amplification** (`PACKET_FACTOR`, capped by `MAX_PACKET_FACTOR`): each
  request is answered with `PACKET_FACTOR` bounded packets, so the target's
  packets-per-second path is stressed, not only its bandwidth.

A request that asks for more than the caps (including a raw sender that ignores
the generator's own limits) is clamped to the caps by the reflector itself.

## Metrics (Prometheus)

The reflector (`METRICS_PORT=9101`) and target (`METRICS_PORT=9102`) each expose
a `/metrics` endpoint in Prometheus text format, scraped only over the internal
lab network:

- `shieldtest_reflector_requests_total`, `_input_bytes_total`,
  `_output_packets_total`, `_output_bytes_total`, `_bap`, `_packet_amplification`
- per profile: `shieldtest_reflector_profile_requests_total{profile=...}` and the
  matching `_input_bytes_total` / `_output_packets_total` / `_output_bytes_total`
- `shieldtest_target_packets_total`, `_bytes_total`, `_avg_pps`, `_avg_bps`

The `monitoring` profile's Prometheus is attached to the lab network and already
scrapes both (job `shieldtest-lab`); the lab targets show as `down` until the
`network-lab` profile is running.

```bash
docker compose --profile monitoring --profile network-lab up -d
# then query e.g. shieldtest_reflector_bap in Grafana (SSH-tunnel to :3000)
```

A Grafana dashboard **"WEDOS ShieldTest — Network Lab"** is auto-provisioned
(`deploy/monitoring/grafana/dashboards/shieldtest-lab.json`): BAP, packet
amplification, mitigating on/off, detection delay, target throughput,
forwarded-vs-dropped and collateral.

## Scenarios (one command)

Named bounded scenarios (`lab/scenarios.mjs`) mirror the control plane's
playbooks. The runner wires the whole chain in-process and prints a summary
(BAP, packet amplification, target PPS/BPS, and scrubber detection/collateral):

```bash
npm run lab:scenario -- amplification-ramp
npm run lab:scenario -- mitigation-delay-study
npm run lab:scenario -- collateral-study
```

## Tests

The lab's safety invariants are covered by a dependency-free integration test
that runs the whole chain in-process over loopback:

```bash
npm run lab:test:caps      # node --test lab/test/*.test.mjs
```

It asserts that the per-packet byte cap and the packet-amplification cap are
never breached (including for a maliciously oversized request), that an unknown
profile label collapses to `other` and cannot inject into the metrics, and that
the CIDR guards reject any out-of-lab target/reflector.

## Hard safety properties (non-negotiable)

- **no source-address spoofing** — the reflection target is fixed by config,
  never taken from the packet source, so this cannot be turned against a victim;
- no real DNS/NTP/SSDP/memcached service and **no public reflector** — profiles
  are synthetic shapes only;
- fixed RFC1918 lab subnet `192.168.100.0/24`; reflector target must match the
  lab prefix;
- unprivileged UDP ports only;
- generator PPS and duration have hard caps;
- reflector byte factor, response size and packet factor have hard caps;
- Docker lab network is `internal: true`; no host ports are published for
  generator, reflector, or target.

This runtime validates filtering, telemetry, detection delay, BAP and
availability in a closed test environment. It must not be attached to production
or public networks, and none of the properties above may be weakened.
