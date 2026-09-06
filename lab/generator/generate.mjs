import dgram from 'node:dgram';
import { assertLabAddressInPrefix } from '../lib/net-guard.mjs';

// Bounded UDP request generator for the closed ShieldTest lab. It only talks to
// the synthetic reflector inside the lab (private/loopback IPv4 only, hard gate),
// at a capped PPS, for a capped duration. `runGenerator()` resolves with the run
// stats so integration tests can await a complete run; the module self-starts
// when run directly.

const PROFILES = new Set(['constant', 'ramp', 'wave', 'burst']);

/**
 * Target PPS at a point in the run (frac 0→1), as a fraction of the base rate.
 * Every profile stays within [0, basePps], so the base rate (≤ MAX_PPS) remains
 * the hard ceiling. Pure — unit-tested.
 */
export function profilePps(profile, basePps, frac) {
  const f = Math.max(0, Math.min(1, frac));
  switch (profile) {
    case 'ramp':
      return basePps * (0.25 + 0.75 * f); // 25% → 100%
    case 'wave':
      return basePps * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * f)); // 2 cycles, [.2,1]
    case 'burst':
      return Math.floor(f * 4) % 2 === 0 ? basePps : basePps * 0.2; // full / 20% quarters
    case 'constant':
    default:
      return basePps;
  }
}

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
  const PROFILE = (env.PROFILE || 'constant').toLowerCase();
  // 'legit' models benign background traffic (never amplified) to measure the
  // scrubber's collateral; point REFLECTOR_HOST at the scrubber in that mode.
  const MODE = (env.MODE || 'attack').toLowerCase();

  // Hard gate: REFLECTOR_HOST must be private/loopback (never public), optionally
  // narrowed by LAB_CIDR_PREFIX. Not env-widenable.
  assertLabAddressInPrefix(REFLECTOR_HOST, env.LAB_CIDR_PREFIX, 'REFLECTOR_HOST');
  if (!PROFILES.has(PROFILE)) throw new Error(`PROFILE must be one of ${[...PROFILES].join(', ')}`);
  if (!Number.isFinite(FACTOR) || FACTOR < 1 || FACTOR > 100)
    throw new Error('FACTOR must be 1..100');
  if (!Number.isFinite(PACKET_FACTOR) || PACKET_FACTOR < 1 || PACKET_FACTOR > MAX_PACKET_FACTOR) {
    throw new Error(`PACKET_FACTOR must be 1..${MAX_PACKET_FACTOR}`);
  }
  if (!Number.isFinite(PPS) || PPS < 1 || PPS > MAX_PPS)
    throw new Error(`PPS must be 1..${MAX_PPS}`);
  if (!Number.isFinite(DURATION_SEC) || DURATION_SEC < 1 || DURATION_SEC > MAX_DURATION_SEC) {
    throw new Error(`DURATION_SEC must be 1..${MAX_DURATION_SEC}`);
  }

  const socket = dgram.createSocket('udp4');
  // Legit background traffic is never amplified (factor/packetFactor = 1).
  const isLegit = MODE === 'legit';
  const payload = Buffer.from(
    JSON.stringify({
      type: isLegit ? 'shieldtest.legit' : 'shieldtest.synthetic-amplification',
      factor: isLegit ? 1 : FACTOR,
      packetFactor: isLegit ? 1 : PACKET_FACTOR,
    }),
  );
  let sent = 0;
  let sentBytes = 0;
  const started = Date.now();
  const TICK_MS = 200;
  const ticksPerSec = 1000 / TICK_MS;
  let acc = 0; // fractional-packet accumulator across ticks

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
          mode: MODE,
          profile: PROFILE,
          factor: isLegit ? 1 : FACTOR,
          packetFactor: isLegit ? 1 : PACKET_FACTOR,
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

    // Shaped scheduler: each tick sends the profile's current PPS pro-rated over
    // the tick, so ramp/wave/burst modulate the rate within the base cap.
    timer = setInterval(() => {
      const frac = (Date.now() - started) / (DURATION_SEC * 1000);
      acc += profilePps(PROFILE, PPS, frac) / ticksPerSec;
      let n = Math.floor(acc);
      acc -= n;
      while (n-- > 0) {
        socket.send(payload, REFLECTOR_PORT, REFLECTOR_HOST, (err) => {
          if (!err) {
            sent++;
            sentBytes += payload.length;
          }
        });
      }
      if (Date.now() - started >= DURATION_SEC * 1000) {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        finish();
      }
    }, TICK_MS);
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runGenerator();
}
