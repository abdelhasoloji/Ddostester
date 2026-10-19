import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { parseCalibration, CalibrationError } from '../src/modules/drs/calibration.js';

const valid = {
  agentId: 'site-a',
  measuredTps: 12_500,
  measuredConcurrency: 400,
  measuredAt: new Date(Date.now() - 3_600_000).toISOString(),
  conditions: 'TLS on, 12 ms RTT, 4 vCPU',
};

describe('calibration record', () => {
  it('accepts a measured record and keeps its conditions', () => {
    const c = parseCalibration(valid);
    expect(c.agentId).toBe('site-a');
    expect(c.measuredTps).toBe(12_500);
    expect(c.conditions).toContain('TLS');
  });

  it.each([
    [{ ...valid, agentId: '' }, /agentId/],
    [{ ...valid, agentId: 'bad id!' }, /agentId/],
    [{ ...valid, measuredTps: 0 }, /measuredTps/],
    [{ ...valid, measuredTps: 9_000_000 }, /measuredTps/],
    [{ ...valid, measuredConcurrency: 1.5 }, /measuredConcurrency/],
    [{ ...valid, measuredAt: 'not-a-date' }, /measuredAt/],
    [{ ...valid, measuredAt: new Date(Date.now() + 3_600_000).toISOString() }, /future/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseCalibration(raw)).toThrow(CalibrationError);
    expect(() => parseCalibration(raw)).toThrow(message);
  });
});

describe('calibration storage', () => {
  it('replaces a calibration per agent', async () => {
    const store = new MemoryStore();
    await store.saveAgentCalibration(parseCalibration(valid));
    await store.saveAgentCalibration(parseCalibration({ ...valid, measuredTps: 20_000 }));
    const all = await store.listAgentCalibrations();
    expect(all).toHaveLength(1);
    expect(all[0].measuredTps).toBe(20_000);
  });
});
