import { describe, expect, it } from 'vitest';
import { certificateHealth } from '../src/modules/fleet/status.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe('certificate health (B — no silent expiry)', () => {
  it('reports a comfortable certificate as ok', () => {
    expect(certificateHealth(NOW + 30 * DAY, NOW)).toEqual({
      expiresAt: NOW + 30 * DAY,
      daysRemaining: 30,
      status: 'ok',
    });
  });

  it('warns inside the seven-day window', () => {
    expect(certificateHealth(NOW + 7 * DAY, NOW).status).toBe('expiring');
    expect(certificateHealth(NOW + 3 * DAY, NOW)).toMatchObject({
      daysRemaining: 3,
      status: 'expiring',
    });
    expect(certificateHealth(NOW + 1, NOW).status).toBe('expiring');
  });

  it('reports an elapsed certificate as expired', () => {
    expect(certificateHealth(NOW, NOW)).toMatchObject({ daysRemaining: 0, status: 'expired' });
    expect(certificateHealth(NOW - DAY, NOW).status).toBe('expired');
  });

  it('floors partial days rather than rounding up', () => {
    expect(certificateHealth(NOW + 3 * DAY - 1, NOW).daysRemaining).toBe(2);
  });

  it('rejects a non-finite expiry', () => {
    expect(() => certificateHealth(Number.NaN, NOW)).toThrow('Invalid certificate expiry');
  });
});
