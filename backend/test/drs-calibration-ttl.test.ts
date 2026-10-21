import { describe, expect, it } from 'vitest';
import { drsCalibrationTtlDays } from '../src/config/drs-calibration.js';

describe('calibration TTL', () => {
  it('defaults to 30 days and honours an explicit value', () => {
    expect(drsCalibrationTtlDays({})).toBe(30);
    expect(drsCalibrationTtlDays({ DRS_CALIBRATION_TTL_DAYS: '7' })).toBe(7);
  });

  it('clamps nonsense to one day and one year', () => {
    expect(drsCalibrationTtlDays({ DRS_CALIBRATION_TTL_DAYS: '0' })).toBe(1);
    expect(drsCalibrationTtlDays({ DRS_CALIBRATION_TTL_DAYS: '5000' })).toBe(365);
    expect(drsCalibrationTtlDays({ DRS_CALIBRATION_TTL_DAYS: 'abc' })).toBe(30);
  });
});
