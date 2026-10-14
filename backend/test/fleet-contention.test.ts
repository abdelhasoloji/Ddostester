import { expect, it } from 'vitest';
import { computeConfidence, fleetCpuContention } from '../src/modules/reports/confidence.js';
it('flags observed cgroup contention without treating missing measurements as zero', () => {
  const shard = (value: unknown) => ({
    result: {
      resources: {
        schema: 'ddostester.fleet.resources/v1',
        elapsedMs: 8000,
        cgroupThrottledUsecDelta: value,
      },
    },
  });
  expect(fleetCpuContention([shard(1200000)])).toBe(true);
  expect(fleetCpuContention([shard(800000)])).toBe(false);
  expect(fleetCpuContention([shard(null), shard('1200000'), {}])).toBe(false);
  expect(computeConfidence({ fleetCpuContention: true }).degraded).toBe(true);
});
