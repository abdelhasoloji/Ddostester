import { expect, it } from 'vitest';
import { parseCgroupCpu, startResourceMeasurement } from '../src/modules/fleet/resources.js';
it('keeps unavailable and malformed throttling evidence unknown', () => {
  expect(parseCgroupCpu('usage_usec 200\nnr_throttled 3\nthrottled_usec 41\n')).toEqual({
    throttledUsec: 41,
    throttledPeriods: 3,
  });
  expect(parseCgroupCpu('usage_usec 200')).toBeNull();
  expect(parseCgroupCpu('nr_throttled -1\nthrottled_usec 0')).toBeNull();
  expect(parseCgroupCpu('nr_throttled 1\nthrottled_usec 99999999999999999')).toBeNull();
});
it('reports process CPU and resident memory with their scope and units', async () => {
  const finish = startResourceMeasurement();
  const result = await finish();
  expect(result.schema).toBe('ddostester.fleet.resources/v1');
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(result.processCpuUserUsec).toBeGreaterThanOrEqual(0);
  expect(result.processCpuSystemUsec).toBeGreaterThanOrEqual(0);
  expect(result.processRssBytesAtFinish).toBeGreaterThan(0);
  expect(result.processPeakRssBytesLifetime).toBeGreaterThan(0);
});
