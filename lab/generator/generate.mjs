import dgram from 'node:dgram';
import net from 'node:net';

// Bounded UDP request generator for the closed ShieldTest lab. It only talks to
// the synthetic reflector inside the lab CIDR, at a capped PPS, for a capped
// duration. `runGenerator()` resolves with the run stats so integration tests
// can await a complete run; the module self-starts when run directly.

export function runGenerator(env = process.env) {
  const REFLECTOR_HOST = env.REFLECTOR_HOST || '192.168.100.50';
  const REFLECTOR_PORT = Number(env.REFLECTOR_PORT || 9001);
  const FACTOR = Number(env.FACTOR || 10);
  const PACKET_FACTOR = Number(env.PACKET_FACTOR || 1);
  const PPS = Number(env.PPS || 20);
  const DURATION_SEC = Number(env.DURATION_SEC || 10);
  const MAX_PPS = Number(env.MAX_PPS || 500);
  const MAX_DURATION_SEC = Number(env.MAX_DURATION_SEC || 60);
  const MAX_PACKET_FACTOR = Number(env.MAX_PACKET_FACTOR || 10);
  const LAB_CIDR_PREFIX = env.LAB_CIDR_PREFIX || '192.168.100.';

  if (!net.isIP(REFLECTOR_HOST) || !REFLECTOR_HOST.startsWith(LAB_CIDR_PREFIX)) {
    throw new Error(`REFLECTOR_HOST must be inside ${LAB_CIDR_PREFIX}0/24`);
  }
  if (!Number.isFinite(FACTOR) || FACTOR < 1 || FACTOR > 100) throw new Error('FACTOR must be 1..100');
  if (!Number.isFinite(PACKET_FACTOR) || PACKET_FACTOR < 1 || PACKET_FACTOR > MAX_PACKET_FACTOR) {
    throw new Error(`PACKET_FACTOR must be 1..${MAX_PACKET_FACTOR}`);
  }
  if (!Number.isFinite(PPS) || PPS < 1 || PPS > MAX_PPS) throw new Error(`PPS must be 1..${MAX_PPS}`);
  if (!Number.isFinite(DURATION_SEC) || DURATION_SEC < 1 || DURATION_SEC > MAX_DURATION_SEC) {
    throw new Error(`DURATION_SEC must be 1..${MAX_DURATION_SEC}`);
  }

  const socket = dgram.createSocket('udp4');
  const payload = Buffer.from(
    JSON.stringify({ type: 'shieldtest.synthetic-amplification', factor: FACTOR, packetFactor: PACKET_FACTOR }),
  );
  let sent = 0;
  let sentBytes = 0;
  const started = Date.now();
  const intervalMs = Math.max(2, Math.floor(1000 / PPS));

  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      setTimeout(() => {
        const result = {
          event: 'generator.complete',
          factor: FACTOR,
          packetFactor: PACKET_FACTOR,
          configuredPps: PPS,
          durationSec: DURATION_SEC,
          sent,
          sentBytes,
        };
        console.log(JSON.stringify(result));
        socket.close(() => resolve(result));
      }, 100);
    };

    // Stop cleanly on shutdown signals; the run resolves with what was sent.
    const onSignal = () => finish();
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    timer = setInterval(() => {
      socket.send(payload, REFLECTOR_PORT, REFLECTOR_HOST, (err) => {
        if (!err) {
          sent++;
          sentBytes += payload.length;
        }
      });
      if (Date.now() - started >= DURATION_SEC * 1000) {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        finish();
      }
    }, intervalMs);
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runGenerator();
}
