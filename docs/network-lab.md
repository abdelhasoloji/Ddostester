# WEDOS ShieldTest Network Lab (safe synthetic amplification)

This lab reproduces the traffic shape and measurement problem of UDP amplification without IP spoofing, public reflectors, or Internet-routable targets.

## Topology

```text
generator (.10) -> synthetic-reflector (.50) -> target (.99)
                         |
                         +-- expands each request by a bounded byte factor (N)
                         +-- and a bounded packet factor (P)
```

All services are attached to the Docker network `shieldtest_lab`, configured with `internal: true`. Docker therefore provides no default external routing for this network.

## Start

```bash
POSTGRES_PASSWORD=dev docker compose --profile network-lab up -d lab-target lab-reflector
```

Run one bounded test:

```bash
FACTOR=10 PACKET_FACTOR=3 PPS=20 DURATION_SEC=10 \
POSTGRES_PASSWORD=dev docker compose --profile network-lab run --rm \
  -e FACTOR -e PACKET_FACTOR -e PPS -e DURATION_SEC lab-generator
```

Inspect metrics:

```bash
docker compose logs --since=1m lab-reflector lab-target
```

The reflector prints `bap = outputBytes / inputBytes` and `packetAmplification = outputPackets / requests`. The target prints cumulative packets/bytes and average PPS/BPS.

## Amplification model

The reflector models two independent, bounded dimensions of amplification:

- **Byte amplification** (`FACTOR`, capped by `MAX_FACTOR` / `MAX_RESPONSE_BYTES`): each response is grown to `min(MAX_RESPONSE_BYTES, requestBytes * FACTOR)`. This is the classic reflection metric (BAP).
- **Packet amplification** (`PACKET_FACTOR`, capped by `MAX_PACKET_FACTOR`): each request is answered with `PACKET_FACTOR` bounded packets, so you can also stress the target's packets-per-second path, not only its bandwidth.

A request that asks for more than the caps (including a raw sender that ignores the generator's own limits) is clamped to the caps by the reflector itself.

## Metrics (Prometheus)

The reflector (`METRICS_PORT=9101`) and target (`METRICS_PORT=9102`) each expose a `/metrics` endpoint in Prometheus text format, scraped only over the internal lab network:

- `shieldtest_reflector_requests_total`, `_input_bytes_total`, `_output_packets_total`, `_output_bytes_total`, `_bap`, `_packet_amplification`
- `shieldtest_target_packets_total`, `_bytes_total`, `_avg_pps`, `_avg_bps`

The `monitoring` profile's Prometheus is attached to the lab network and already scrapes both (job `shieldtest-lab`); the lab targets show as `down` until the `network-lab` profile is running.

```bash
docker compose --profile monitoring --profile network-lab up -d
# then query e.g. shieldtest_reflector_bap in Grafana (SSH-tunnel to :3000)
```

## Tests

The lab's safety invariants are covered by a dependency-free integration test that runs the whole chain in-process over loopback:

```bash
npm run lab:test:caps      # node --test lab/test/*.test.mjs
```

It asserts that the per-packet byte cap and the packet-amplification cap are never breached (including for a maliciously oversized request), and that the CIDR guards reject any out-of-lab target/reflector.

## Hard safety properties

- no source-address spoofing (the reflection target is fixed by config, never taken from the packet source);
- no DNS/NTP/Memcached services;
- fixed RFC1918 lab subnet `192.168.100.0/24`;
- reflector target must match the lab prefix;
- unprivileged UDP ports only;
- generator PPS and duration have hard caps;
- reflector byte factor, response size and packet factor have hard caps;
- Docker lab network is `internal: true`;
- no host ports are published for generator, reflector, or target.

This runtime is intended to validate filtering, telemetry, detection delay, BAP, and availability in a closed test environment. It must not be attached to production or public networks.
