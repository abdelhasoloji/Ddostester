import { describe, it, expect } from 'vitest';
import { dueCampaigns, reArmRecurring } from '../src/modules/campaigns/scheduler.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const base: Campaign = {
  id: 'c1',
  name: 'x',
  target: 'http://localhost/',
  probeUrl: 'http://localhost/',
  vector: 'http-get',
  maxRps: 10,
  concurrency: 2,
  maxDurationSec: 10,
  createdBy: 'e',
  authorized: true,
  status: 'APPROVED',
  createdAt: '2026-01-01T00:00:00Z',
};
const now = Date.parse('2026-01-01T12:00:00Z');

describe('dueCampaigns', () => {
  it('selects an approved campaign whose window is due', () => {
    const c = { ...base, scheduledAt: '2026-01-01T11:59:00Z' };
    expect(dueCampaigns([c], now).map((x) => x.id)).toEqual(['c1']);
  });
  it('ignores a future window', () => {
    const c = { ...base, scheduledAt: '2026-01-01T13:00:00Z' };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
  it('ignores a non-approved campaign', () => {
    const c = { ...base, status: 'PENDING_APPROVAL' as const, scheduledAt: '2026-01-01T11:00:00Z' };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
  it('ignores a campaign with no scheduledAt', () => {
    expect(dueCampaigns([base], now)).toHaveLength(0);
  });
  it('ignores a campaign whose approval expired', () => {
    const c = {
      ...base,
      scheduledAt: '2026-01-01T11:00:00Z',
      approvalExpiresAt: '2026-01-01T10:00:00Z',
    };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
});

describe('reArmRecurring', () => {
  it('returns null for a non-recurring campaign', () => {
    expect(reArmRecurring(base, now)).toBeNull();
  });
  it('computes the next run at now + intervalMin', () => {
    const c = { ...base, recurrence: { intervalMin: 30 } };
    const r = reArmRecurring(c, now);
    expect(r?.scheduledAt).toBe(new Date(now + 30 * 60_000).toISOString());
  });
  it('stops when the next run would fall after "until"', () => {
    const c = { ...base, recurrence: { intervalMin: 60, until: '2026-01-01T12:30:00Z' } };
    expect(reArmRecurring(c, now)).toBeNull();
  });
  it('stops when the next run would fall after the approval expiry', () => {
    const c = {
      ...base,
      approvalExpiresAt: '2026-01-01T12:10:00Z',
      recurrence: { intervalMin: 30 },
    };
    expect(reArmRecurring(c, now)).toBeNull();
  });
  it('re-arms while still inside the approval window', () => {
    const c = {
      ...base,
      approvalExpiresAt: '2026-01-02T00:00:00Z',
      recurrence: { intervalMin: 60 },
    };
    expect(reArmRecurring(c, now)?.scheduledAt).toBe(new Date(now + 60 * 60_000).toISOString());
  });
});
