import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGenerator, profilePps } from '../generator/generate.mjs';

test('profilePps stays within [0, basePps] for every profile', () => {
  const base = 100;
  for (const profile of ['constant', 'ramp', 'wave', 'burst', 'unknown']) {
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const pps = profilePps(profile, base, f);
      assert.ok(pps >= 0 && pps <= base, `${profile}@${f.toFixed(2)} = ${pps} out of [0,${base}]`);
    }
  }
});

test('ramp rises from 25% to 100% of base', () => {
  assert.ok(Math.abs(profilePps('ramp', 100, 0) - 25) < 0.001);
  assert.ok(Math.abs(profilePps('ramp', 100, 1) - 100) < 0.001);
});

test('legit mode sends benign, never-amplified packets', async () => {
  const result = await runGenerator({
    REFLECTOR_HOST: '127.0.0.1',
    LAB_CIDR_PREFIX: '127.0.0.',
    MODE: 'legit',
    SHAPE: 'constant',
    PPS: '20',
    DURATION_SEC: '1',
    FACTOR: '50',
    PACKET_FACTOR: '5',
  });
  assert.equal(result.mode, 'legit');
  assert.equal(result.factor, 1);
  assert.equal(result.packetFactor, 1);
  assert.ok(result.sent > 0, 'should have sent packets');
});

test('rejects an unknown profile', () => {
  assert.throws(
    () =>
      runGenerator({ REFLECTOR_HOST: '127.0.0.1', LAB_CIDR_PREFIX: '127.0.0.', PROFILE: 'nope' }),
    /PROFILE must be one of/,
  );
});
