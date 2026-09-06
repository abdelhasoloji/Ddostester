import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTarget } from '../target/receiver.mjs';
import { createReflector } from '../synthetic-reflector/server.mjs';

const LOOPBACK = '127.0.0.1';
const PREFIX = '127.0.0.';
const randint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function startAsync(c) {
  return new Promise((resolve) => c.start((port) => resolve(port)));
}
function stopAsync(c) {
  return new Promise((resolve) => c.stop(resolve));
}

// Property: for ANY caps and ANY (even absurd) request, the reflector never
// exceeds the per-packet byte cap nor the packet-amplification cap. Fuzzed by
// firing many random raw packets — no generator, so it stays fast.
test('caps hold under fuzzed caps and adversarial requests', async () => {
  for (let round = 0; round < 6; round++) {
    const MAX_RESPONSE_BYTES = randint(64, 4096);
    const MAX_PACKET_FACTOR = randint(1, 12);

    const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
    const targetPort = await startAsync(target);
    const reflector = createReflector({
      LISTEN_HOST: LOOPBACK,
      LISTEN_PORT: '0',
      TARGET_HOST: LOOPBACK,
      TARGET_PORT: String(targetPort),
      LAB_CIDR_PREFIX: PREFIX,
      MAX_FACTOR: '100',
      MAX_RESPONSE_BYTES: String(MAX_RESPONSE_BYTES),
      MAX_PACKET_FACTOR: String(MAX_PACKET_FACTOR),
    });
    const reflectorPort = await startAsync(reflector);

    const evil = dgram.createSocket('udp4');
    for (let i = 0; i < 120; i++) {
      // Random, sometimes absurd, request (including non-JSON garbage).
      const body =
        Math.random() < 0.15
          ? Buffer.from('not-json-'.repeat(randint(1, 40)))
          : Buffer.from(
              JSON.stringify({ factor: randint(-5, 99999), packetFactor: randint(-5, 99999) }),
            );
      evil.send(body, reflectorPort, LOOPBACK, () => {});
    }
    await sleep(150);
    evil.close();

    const m = reflector.metrics;
    assert.ok(
      m.outputBytes <= m.outputPackets * MAX_RESPONSE_BYTES,
      `round ${round}: ${m.outputBytes} > ${m.outputPackets} * ${MAX_RESPONSE_BYTES}`,
    );
    assert.ok(
      m.outputPackets <= m.requests * MAX_PACKET_FACTOR,
      `round ${round}: ${m.outputPackets} > ${m.requests} * ${MAX_PACKET_FACTOR}`,
    );

    await stopAsync(reflector);
    await stopAsync(target);
  }
});
