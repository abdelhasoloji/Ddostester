import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';

import { createTarget } from '../target/receiver.mjs';
import { createReflector } from '../synthetic-reflector/server.mjs';
import { runGenerator } from '../generator/generate.mjs';

// Loopback keeps the whole chain in-process; the lab CIDR guard is satisfied by
// pointing LAB_CIDR_PREFIX at 127.0.0.
const LOOPBACK = '127.0.0.1';
const PREFIX = '127.0.0.';

function startAsync(component) {
  return new Promise((resolve) => component.start((port) => resolve(port)));
}
function stopAsync(component) {
  return new Promise((resolve) => component.stop(resolve));
}

test('bounded end-to-end run never exceeds the byte and packet caps', async () => {
  const MAX_RESPONSE_BYTES = 512;
  const MAX_PACKET_FACTOR = 4;

  const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
  const targetPort = await startAsync(target);

  const reflector = createReflector({
    LISTEN_HOST: LOOPBACK,
    LISTEN_PORT: '0',
    TARGET_HOST: LOOPBACK,
    TARGET_PORT: String(targetPort),
    LAB_CIDR_PREFIX: PREFIX,
    MAX_RESPONSE_BYTES: String(MAX_RESPONSE_BYTES),
    MAX_PACKET_FACTOR: String(MAX_PACKET_FACTOR),
  });
  const reflectorPort = await startAsync(reflector);

  const result = await runGenerator({
    REFLECTOR_HOST: LOOPBACK,
    REFLECTOR_PORT: String(reflectorPort),
    LAB_CIDR_PREFIX: PREFIX,
    FACTOR: '50',
    PACKET_FACTOR: '3',
    PPS: '50',
    DURATION_SEC: '2',
    MAX_PACKET_FACTOR: String(MAX_PACKET_FACTOR),
  });

  await sleep(300); // drain in-flight UDP callbacks

  const m = reflector.metrics;
  assert.ok(result.sent > 0, 'generator should have sent packets');
  assert.ok(m.requests > 0, 'reflector should have received requests');

  // SAFETY INVARIANT 1 — per-packet byte cap is never breached.
  assert.ok(
    m.outputBytes <= m.outputPackets * MAX_RESPONSE_BYTES,
    `output bytes ${m.outputBytes} exceed ${m.outputPackets} * ${MAX_RESPONSE_BYTES}`,
  );

  // SAFETY INVARIANT 2 — packet amplification is bounded by the cap.
  assert.ok(
    m.outputPackets <= m.requests * MAX_PACKET_FACTOR,
    `packet amplification ${m.outputPackets}/${m.requests} exceeds cap ${MAX_PACKET_FACTOR}`,
  );

  // The target only ever sees what the reflector actually emitted.
  assert.ok(target.metrics.packets <= m.outputPackets, 'target saw phantom packets');

  await stopAsync(reflector);
  await stopAsync(target);
});

test('reflector clamps a maliciously oversized request', async () => {
  const MAX_RESPONSE_BYTES = 256;
  const MAX_PACKET_FACTOR = 4;

  const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
  const targetPort = await startAsync(target);

  const reflector = createReflector({
    LISTEN_HOST: LOOPBACK,
    LISTEN_PORT: '0',
    TARGET_HOST: LOOPBACK,
    TARGET_PORT: String(targetPort),
    LAB_CIDR_PREFIX: PREFIX,
    MAX_FACTOR: '50',
    MAX_RESPONSE_BYTES: String(MAX_RESPONSE_BYTES),
    MAX_PACKET_FACTOR: String(MAX_PACKET_FACTOR),
  });
  const reflectorPort = await startAsync(reflector);

  // A raw sender that ignores the generator's own limits and asks for the moon.
  const evil = dgram.createSocket('udp4');
  const payload = Buffer.from(JSON.stringify({ factor: 9999, packetFactor: 9999 }));
  await new Promise((resolve, reject) =>
    evil.send(payload, reflectorPort, LOOPBACK, (err) => (err ? reject(err) : resolve())),
  );
  await sleep(300);
  evil.close();

  const m = reflector.metrics;
  assert.equal(m.requests, 1);
  // Clamped to exactly the caps, never beyond.
  assert.ok(m.outputPackets <= MAX_PACKET_FACTOR, `emitted ${m.outputPackets} > cap ${MAX_PACKET_FACTOR}`);
  assert.ok(
    m.outputBytes <= MAX_PACKET_FACTOR * MAX_RESPONSE_BYTES,
    `emitted ${m.outputBytes} bytes > cap ${MAX_PACKET_FACTOR * MAX_RESPONSE_BYTES}`,
  );

  await stopAsync(reflector);
  await stopAsync(target);
});

test('reflector rejects a target outside the lab CIDR', () => {
  assert.throws(
    () =>
      createReflector({
        TARGET_HOST: '8.8.8.8',
        LAB_CIDR_PREFIX: '192.168.100.',
      }),
    /TARGET_HOST must be an IPv4 address inside/,
  );
});

test('generator rejects a reflector outside the lab CIDR', () => {
  assert.throws(
    () => runGenerator({ REFLECTOR_HOST: '1.1.1.1', LAB_CIDR_PREFIX: '192.168.100.' }),
    /REFLECTOR_HOST must be inside/,
  );
});

test('per-profile metrics break down by synthetic shape', async () => {
  const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
  const targetPort = await startAsync(target);

  const reflector = createReflector({
    LISTEN_HOST: LOOPBACK,
    LISTEN_PORT: '0',
    TARGET_HOST: LOOPBACK,
    TARGET_PORT: String(targetPort),
    LAB_CIDR_PREFIX: PREFIX,
    MAX_FACTOR: '50',
    MAX_PACKET_FACTOR: '10',
  });
  const reflectorPort = await startAsync(reflector);

  await runGenerator({
    REFLECTOR_HOST: LOOPBACK,
    REFLECTOR_PORT: String(reflectorPort),
    LAB_CIDR_PREFIX: PREFIX,
    PROFILE: 'dns',
    PPS: '50',
    DURATION_SEC: '1',
  });
  await sleep(300);

  const dns = reflector.byProfile.get('dns');
  assert.ok(dns && dns.requests > 0, 'dns profile bucket should be populated');
  assert.ok(dns.outputBytes > dns.inputBytes, 'dns profile should show byte amplification');
  assert.ok(!reflector.byProfile.has('generic'), 'no unrelated profile bucket');

  await stopAsync(reflector);
  await stopAsync(target);
});

test('an unknown profile label collapses to "other"', async () => {
  const target = createTarget({ LISTEN_HOST: LOOPBACK, LISTEN_PORT: '0' });
  const targetPort = await startAsync(target);
  const reflector = createReflector({
    LISTEN_HOST: LOOPBACK,
    LISTEN_PORT: '0',
    TARGET_HOST: LOOPBACK,
    TARGET_PORT: String(targetPort),
    LAB_CIDR_PREFIX: PREFIX,
  });
  const reflectorPort = await startAsync(reflector);

  const raw = dgram.createSocket('udp4');
  const payload = Buffer.from(JSON.stringify({ profile: 'evil"}\n injection', factor: 2, packetFactor: 1 }));
  await new Promise((resolve, reject) =>
    raw.send(payload, reflectorPort, LOOPBACK, (err) => (err ? reject(err) : resolve())),
  );
  await sleep(300);
  raw.close();

  assert.ok(reflector.byProfile.has('other'), 'unknown profile should bucket as other');
  assert.ok(!reflector.byProfile.has('evil"}\n injection'), 'raw label must never become a bucket');
  // The exposition text must not be broken by the injected label.
  assert.ok(!reflector.renderMetrics().includes('injection'), 'untrusted label leaked into metrics');

  await stopAsync(reflector);
  await stopAsync(target);
});

test('generator rejects an unknown profile', () => {
  assert.throws(() => runGenerator({ PROFILE: 'bogus', LAB_CIDR_PREFIX: PREFIX }), /PROFILE must be one of/);
});
