# Engine module — bounded HTTP generation

This directory holds the traffic generator and its measurement primitives. It is
not a packet-level or amplification engine.

- `loadTest.ts` — the built-in HTTP generator. Requests go through `undici`
  against a single allowlisted host (`validateConfig`), with a mandatory `maxRps`
  and a hard per-run deadline. No raw sockets, no spoofed source addresses, no
  reflected traffic.
- `slowloris.ts` — the one module that opens a raw TCP connection
  (`net.connect`), to hold a well-formed-but-incomplete HTTP request. It sends no
  payload beyond the header prefix and is bounded by the same allowlist.
- `stats.ts` — `LatencyRecorder`: O(1) ingest, histogram-backed live percentiles,
  exact final percentiles.
- `types.ts`, `correlation.ts`, `iot-profile.ts` — request shapes, extraction and
  bounded business-flow profiles.

Ceilings are **not** defined here. Import them from `config/limits.ts`:

- `HARD_CAPS` — frozen, server-enforced ceiling for one run (2,000 rps / 500
  concurrent / 900 s). Never bypassable through the API.
- `BUILTIN_RPS_CEILING` (150) and `BUILTIN_CONCURRENCY_CEILING` (300) — the
  measured sustainable envelope of the in-process engine. Above it,
  `modules/campaigns/engine-route.ts` routes to an out-of-process adapter, and a
  run that cannot be routed is refused rather than silently under-delivered
  (`builtinUnderDeliveryReason`).
- `FLEET_LIMITS` — the much smaller shared fleet envelope (15 rps / 6 / 3 agents).

See [boundary and lab](../../../docs/boundary-and-lab.md) and
[engine strategy](../../../docs/engine-strategy.md).
