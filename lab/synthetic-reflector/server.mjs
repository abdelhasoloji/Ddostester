import dgram from 'node:dgram';
import http from 'node:http';
import { assertLabAddressInPrefix } from '../lib/net-guard.mjs';

// Synthetic UDP amplification reflector for the closed ShieldTest lab.
//
// Safety by construction:
//   - the reflection TARGET is fixed by env, never taken from the packet source
//     address, so source-IP spoofing cannot be modelled here;
//   - byte amplification is bounded by MAX_RESPONSE_BYTES;
//   - packet amplification is bounded by MAX_PACKET_FACTOR;
//   - the target must be a private/loopback IPv4 (hard, non-bypassable gate),
//     optionally narrowed further by LAB_CIDR_PREFIX.
//
// `createReflector()` builds an instance without side effects so it can be
// driven from integration tests; the module also self-starts when run directly.

export function createReflector(env = process.env) {
  const LISTEN_HOST = env.LISTEN_HOST || '0.0.0.0';
  const LISTEN_PORT = Number(env.LISTEN_PORT || 9001);
  const TARGET_HOST = env.TARGET_HOST || '192.168.100.99';
  const TARGET_PORT = Number(env.TARGET_PORT || 9002);
  const MAX_FACTOR = Number(env.MAX_FACTOR || 50);
  const MAX_RESPONSE_BYTES = Number(env.MAX_RESPONSE_BYTES || 8192);
  const MAX_PACKET_FACTOR = Number(env.MAX_PACKET_FACTOR || 10);
  const METRICS_PORT = Number(env.METRICS_PORT || 0); // 0 disables the metrics endpoint

  // Hard gate: TARGET_HOST must be private/loopback (never a public IP), with an
  // optional extra narrowing to LAB_CIDR_PREFIX. Not env-widenable.
  assertLabAddressInPrefix(TARGET_HOST, env.LAB_CIDR_PREFIX, 'TARGET_HOST');
  if (!Number.isInteger(TARGET_PORT) || TARGET_PORT < 1024 || TARGET_PORT > 65535) {
    throw new Error('TARGET_PORT must be an unprivileged UDP port');
  }
  if (!Number.isFinite(MAX_FACTOR) || MAX_FACTOR < 1 || MAX_FACTOR > 100) {
    throw new Error('MAX_FACTOR must be between 1 and 100');
  }
  if (
    !Number.isFinite(MAX_RESPONSE_BYTES) ||
    MAX_RESPONSE_BYTES < 64 ||
    MAX_RESPONSE_BYTES > 65507
  ) {
    throw new Error('MAX_RESPONSE_BYTES must be between 64 and 65507');
  }
  if (!Number.isFinite(MAX_PACKET_FACTOR) || MAX_PACKET_FACTOR < 1 || MAX_PACKET_FACTOR > 100) {
    throw new Error('MAX_PACKET_FACTOR must be between 1 and 100');
  }

  const input = dgram.createSocket('udp4');
  const output = dgram.createSocket('udp4');
  let metricsServer = null;

  const metrics = {
    requests: 0,
    inputBytes: 0,
    outputPackets: 0,
    outputBytes: 0,
    get bap() {
      return this.inputBytes > 0 ? Number((this.outputBytes / this.inputBytes).toFixed(2)) : 0;
    },
    get packetAmplification() {
      return this.requests > 0 ? Number((this.outputPackets / this.requests).toFixed(2)) : 0;
    },
  };

  function parseRequest(msg) {
    try {
      const parsed = JSON.parse(msg.toString('utf8'));
      const factor = Math.min(MAX_FACTOR, Math.max(1, Math.floor(Number(parsed.factor || 1))));
      const packetFactor = Math.min(
        MAX_PACKET_FACTOR,
        Math.max(1, Math.floor(Number(parsed.packetFactor || 1))),
      );
      return { factor, packetFactor };
    } catch {
      return { factor: 1, packetFactor: 1 };
    }
  }

  input.on('message', (msg) => {
    metrics.requests++;
    metrics.inputBytes += msg.length;
    const { factor, packetFactor } = parseRequest(msg);
    const requestedBytes = Math.max(msg.length, Math.floor(msg.length * factor));
    const responseBytes = Math.min(MAX_RESPONSE_BYTES, requestedBytes);
    const payload = Buffer.alloc(responseBytes, 0x57); // deterministic WEDOS lab payload
    // Packet amplification: emit `packetFactor` bounded responses per request.
    for (let i = 0; i < packetFactor; i++) {
      output.send(payload, TARGET_PORT, TARGET_HOST, (err) => {
        if (!err) {
          metrics.outputPackets++;
          metrics.outputBytes += payload.length;
        }
      });
    }
  });

  function renderMetrics() {
    return [
      '# HELP shieldtest_reflector_requests_total UDP requests received by the reflector.',
      '# TYPE shieldtest_reflector_requests_total counter',
      `shieldtest_reflector_requests_total ${metrics.requests}`,
      '# HELP shieldtest_reflector_input_bytes_total Bytes received by the reflector.',
      '# TYPE shieldtest_reflector_input_bytes_total counter',
      `shieldtest_reflector_input_bytes_total ${metrics.inputBytes}`,
      '# HELP shieldtest_reflector_output_packets_total Packets emitted toward the target.',
      '# TYPE shieldtest_reflector_output_packets_total counter',
      `shieldtest_reflector_output_packets_total ${metrics.outputPackets}`,
      '# HELP shieldtest_reflector_output_bytes_total Bytes emitted toward the target.',
      '# TYPE shieldtest_reflector_output_bytes_total counter',
      `shieldtest_reflector_output_bytes_total ${metrics.outputBytes}`,
      '# HELP shieldtest_reflector_bap Byte amplification factor (output/input).',
      '# TYPE shieldtest_reflector_bap gauge',
      `shieldtest_reflector_bap ${metrics.bap}`,
      '# HELP shieldtest_reflector_packet_amplification Packet amplification (output/input).',
      '# TYPE shieldtest_reflector_packet_amplification gauge',
      `shieldtest_reflector_packet_amplification ${metrics.packetAmplification}`,
      '',
    ].join('\n');
  }

  function start(onReady) {
    input.bind(LISTEN_PORT, LISTEN_HOST, () => {
      console.log(
        JSON.stringify({
          event: 'reflector.ready',
          listen: `${LISTEN_HOST}:${input.address().port}`,
          target: `${TARGET_HOST}:${TARGET_PORT}`,
          maxFactor: MAX_FACTOR,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          maxPacketFactor: MAX_PACKET_FACTOR,
        }),
      );
      if (METRICS_PORT > 0) {
        metricsServer = http.createServer((req, res) => {
          if (req.url === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
            res.end(renderMetrics());
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        metricsServer.listen(METRICS_PORT, LISTEN_HOST);
      }
      if (onReady) onReady(input.address().port);
    });
  }

  function stop(done) {
    let pending = 2 + (metricsServer ? 1 : 0);
    const settle = () => {
      pending--;
      if (pending <= 0 && done) done();
    };
    input.close(settle);
    output.close(settle);
    if (metricsServer) metricsServer.close(settle);
  }

  return { start, stop, metrics, renderMetrics };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const reflector = createReflector();
  reflector.start();
  setInterval(() => {
    const m = reflector.metrics;
    console.log(
      JSON.stringify({
        event: 'reflector.metrics',
        requests: m.requests,
        inputBytes: m.inputBytes,
        outputPackets: m.outputPackets,
        outputBytes: m.outputBytes,
        bap: m.bap,
        packetAmplification: m.packetAmplification,
      }),
    );
  }, 5000).unref();
  const stop = () => reflector.stop(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
