import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrubber } from '../scrubber/server.mjs';
import { createTarget } from '../target/receiver.mjs';

// These JSON shapes are what the control plane's pull connectors consume:
//   PROTECTION_METRICS_URL  → { detectionTimeSec, mitigationTimeSec, source }
//   TARGET_TELEMETRY_METRICS_URL → { nicRxMbps, ... }

test('scrubber /protection JSON matches the measured-WRS connector shape', () => {
  const s = createScrubber({
    TARGET_HOST: '127.0.0.1',
    LAB_CIDR_PREFIX: '127.0.0.',
    THRESHOLD_PPS: '5',
    CEILING_PPS: '2',
    DETECTION_DELAY_SEC: '1',
  });
  let p = s.protectionJson();
  assert.equal(p.source, 'lab-scrubber');
  assert.equal(p.detectionTimeSec, 0);
  assert.equal(p.mitigationTimeSec, 0);
  // Engage mitigation over two windows.
  for (let i = 0; i < 10; i++) s.ingest(Buffer.from('{}'));
  s.tick();
  for (let i = 0; i < 10; i++) s.ingest(Buffer.from('{}'));
  s.tick();
  p = s.protectionJson();
  assert.ok(p.detectionTimeSec > 0, 'detectionTimeSec should be measured');
  assert.ok(p.mitigationTimeSec > 0, 'mitigationTimeSec should be set once mitigating');
});

test('target /telemetry JSON matches the target-telemetry connector shape', () => {
  const t = createTarget({ LISTEN_HOST: '127.0.0.1', LISTEN_PORT: '0' });
  const j = t.telemetryJson();
  assert.ok(typeof j.nicRxMbps === 'number' && j.nicRxMbps >= 0, 'nicRxMbps must be a number');
});
