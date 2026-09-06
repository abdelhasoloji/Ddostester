import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrubber } from '../scrubber/server.mjs';

const attack = Buffer.from(JSON.stringify({ type: 'shieldtest.synthetic-amplification' }));
const legit = Buffer.from(JSON.stringify({ type: 'shieldtest.legit' }));

function scrubber() {
  return createScrubber({
    TARGET_HOST: '127.0.0.1',
    LAB_CIDR_PREFIX: '127.0.0.',
    THRESHOLD_PPS: '5',
    CEILING_PPS: '2',
    DETECTION_DELAY_SEC: '1',
  });
}

test('engages mitigation after the detection delay and records it', () => {
  const s = scrubber();
  // Window 1: over threshold, but the delay has not elapsed yet.
  for (let i = 0; i < 10; i++) s.ingest(attack);
  s.tick();
  assert.equal(s.metrics.mitigating, false);
  // Window 2: still over threshold → delay elapsed → mitigation engages.
  for (let i = 0; i < 10; i++) s.ingest(attack);
  s.tick();
  assert.equal(s.metrics.mitigating, true);
  assert.equal(s.metrics.detectionDelaySec, 2);
});

test('once mitigating, forwards only up to the ceiling and drops the excess', () => {
  const s = scrubber();
  for (let i = 0; i < 10; i++) s.ingest(attack);
  s.tick();
  for (let i = 0; i < 10; i++) s.ingest(attack);
  s.tick(); // now mitigating, window reset
  // Window 3: 8 attack then 4 legit, ceiling 2 → 2 forwarded, 10 dropped.
  for (let i = 0; i < 8; i++) s.ingest(attack);
  for (let i = 0; i < 4; i++) s.ingest(legit);
  assert.equal(s.metrics.dropped, 10);
  assert.equal(s.metrics.droppedLegit, 4);
  assert.equal(s.metrics.droppedAttack, 6);
  assert.equal(s.metrics.collateralPct, 40);
  assert.ok(s.metrics.forwarded < s.metrics.received, 'forwarded must be below received');
});

test('rejects a public forwarding target (hard gate) and a bad ceiling', () => {
  assert.throws(() => createScrubber({ TARGET_HOST: '8.8.8.8' }), /private\/loopback IPv4/);
  assert.throws(
    () =>
      createScrubber({
        TARGET_HOST: '127.0.0.1',
        LAB_CIDR_PREFIX: '127.0.0.',
        CEILING_PPS: '999',
        THRESHOLD_PPS: '5',
      }),
    /CEILING_PPS/,
  );
});
