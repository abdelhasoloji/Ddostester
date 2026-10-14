import { it, expect } from 'vitest';
import { benchAttachment } from '../src/modules/drs/attachments.js';
it('preserves actual received load as read-only diagnostic evidence without multiplying it', () => {
  const a = benchAttachment({
    id: 'fixture',
    scenario: 'closed-lab',
    labTarget: '10.0.0.2',
    status: 'COMPLETED',
    requestedBy: 'fixture',
    requestedAt: new Date().toISOString(),
    verdict: {
      schema: 'fixture',
      class: 'C',
      amplificationFactor: 100,
      target: { avgBps: 1e9, avgPps: 1000 },
    },
  });
  expect(a.measurements.actual_received_load).toEqual({ bps: 1e9, pps: 1000 });
  expect(a.measurements.declared_synthetic_factor).toBe(100);
  expect(a.limitations).toContain(
    'No numeric amplification multiplier is applied to received measurements',
  );
  expect(a.sourceHash).toHaveLength(64);
});
