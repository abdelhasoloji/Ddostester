import dgram from 'node:dgram';
import http from 'node:http';

// Passive UDP sink for the closed ShieldTest lab. It only measures what lands
// on it (packets, bytes, average PPS/BPS) and never replies, so it cannot take
// part in any reflection chain.
//
// `createTarget()` builds an instance without side effects for integration
// tests; the module self-starts when run directly.

export function createTarget(env = process.env) {
  const HOST = env.LISTEN_HOST || '0.0.0.0';
  const PORT = Number(env.LISTEN_PORT || 9002);
  const METRICS_PORT = Number(env.METRICS_PORT || 0); // 0 disables the metrics endpoint

  const socket = dgram.createSocket('udp4');
  let metricsServer = null;
  let packets = 0;
  let bytes = 0;
  const startedAt = Date.now();

  const metrics = {
    get packets() {
      return packets;
    },
    get bytes() {
      return bytes;
    },
    get avgPps() {
      const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
      return Number((packets / elapsedSec).toFixed(2));
    },
    get avgBps() {
      const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
      return Number(((bytes * 8) / elapsedSec).toFixed(2));
    },
  };

  socket.on('message', (msg) => {
    packets++;
    bytes += msg.length;
  });

  function renderMetrics() {
    return [
      '# HELP shieldtest_target_packets_total Packets received by the lab target.',
      '# TYPE shieldtest_target_packets_total counter',
      `shieldtest_target_packets_total ${packets}`,
      '# HELP shieldtest_target_bytes_total Bytes received by the lab target.',
      '# TYPE shieldtest_target_bytes_total counter',
      `shieldtest_target_bytes_total ${bytes}`,
      '# HELP shieldtest_target_avg_pps Average packets per second since start.',
      '# TYPE shieldtest_target_avg_pps gauge',
      `shieldtest_target_avg_pps ${metrics.avgPps}`,
      '# HELP shieldtest_target_avg_bps Average bits per second since start.',
      '# TYPE shieldtest_target_avg_bps gauge',
      `shieldtest_target_avg_bps ${metrics.avgBps}`,
      '',
    ].join('\n');
  }

  function start(onReady) {
    socket.bind(PORT, HOST, () => {
      console.log(
        JSON.stringify({ event: 'target.ready', listen: `${HOST}:${socket.address().port}` }),
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
        metricsServer.listen(METRICS_PORT, HOST);
      }
      if (onReady) onReady(socket.address().port);
    });
  }

  function stop(done) {
    let pending = 1 + (metricsServer ? 1 : 0);
    const settle = () => {
      pending--;
      if (pending <= 0 && done) done();
    };
    socket.close(settle);
    if (metricsServer) metricsServer.close(settle);
  }

  return { start, stop, metrics, renderMetrics };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const target = createTarget();
  target.start();
  setInterval(() => {
    console.log(
      JSON.stringify({
        event: 'target.metrics',
        packets: target.metrics.packets,
        bytes: target.metrics.bytes,
        avgPps: target.metrics.avgPps,
        avgBps: target.metrics.avgBps,
      }),
    );
  }, 5000).unref();
  const stop = () => target.stop(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
