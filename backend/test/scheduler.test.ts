import { describe, it, expect } from 'vitest';
import { dueCampaigns } from '../src/modules/campaigns/scheduler.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

const base: Campaign = {
  id: 'c1', name: 'x', target: 'http://localhost/', probeUrl: 'http://localhost/',
  vector: 'http-get', maxRps: 10, concurrency: 2, maxDurationSec: 10,
  createdBy: 'e', authorized: true, status: 'APPROVED', createdAt: '2026-01-01T00:00:00Z',
};
const now = Date.parse('2026-01-01T12:00:00Z');

describe('dueCampaigns', () => {
  it('sélectionne une campagne approuvée dont la fenêtre est échue', () => {
    const c = { ...base, scheduledAt: '2026-01-01T11:59:00Z' };
    expect(dueCampaigns([c], now).map((x) => x.id)).toEqual(['c1']);
  });
  it('ignore une fenêtre future', () => {
    const c = { ...base, scheduledAt: '2026-01-01T13:00:00Z' };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
  it('ignore une campagne non approuvée', () => {
    const c = { ...base, status: 'PENDING_APPROVAL' as const, scheduledAt: '2026-01-01T11:00:00Z' };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
  it('ignore sans scheduledAt', () => {
    expect(dueCampaigns([base], now)).toHaveLength(0);
  });
  it('ignore si approbation expirée', () => {
    const c = { ...base, scheduledAt: '2026-01-01T11:00:00Z', approvalExpiresAt: '2026-01-01T10:00:00Z' };
    expect(dueCampaigns([c], now)).toHaveLength(0);
  });
});
