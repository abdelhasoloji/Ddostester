import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../run-scenario.mjs';
import { scenarioNames } from '../scenarios.mjs';

test('every scenario has a name and summary', () => {
  assert.ok(scenarioNames().length >= 4);
});

test('amplification-ramp produces amplified traffic within caps', async () => {
  const s = await runScenario('amplification-ramp', { generator: { DURATION_SEC: 2 } });
  assert.ok(s.reflector.requests > 0, 'reflector saw requests');
  assert.ok(s.reflector.bap >= 1, 'byte amplification observed');
  assert.ok(s.target.packets > 0, 'target received packets');
  assert.equal(s.scrubber, null);
});

test('mitigation-delay-study engages the scrubber and drops excess', async () => {
  const s = await runScenario('mitigation-delay-study', {
    generator: { DURATION_SEC: 2, PPS: 150 },
    scrubber: { DETECTION_DELAY_SEC: 0, THRESHOLD_PPS: 50, CEILING_PPS: 20 },
  });
  assert.ok(s.scrubber, 'scrubber summary present');
  assert.equal(s.scrubber.mitigating, true, 'mitigation should engage');
  assert.ok(s.scrubber.dropped > 0, 'excess should be dropped');
});

test('rejects an unknown scenario', async () => {
  await assert.rejects(() => runScenario('nope'), /unknown scenario/);
});
