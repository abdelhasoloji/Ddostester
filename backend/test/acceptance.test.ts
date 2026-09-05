import { describe, it, expect } from 'vitest';
import { evaluateAcceptance, hasCriteria } from '../src/modules/campaigns/acceptance.js';
import { createCampaign, CampaignError } from '../src/modules/campaigns/service.js';
import { buildSuites } from '../src/modules/playbooks/suites.js';
import type { CampaignInput, Campaign } from '../src/modules/campaigns/model.js';

const metrics = { p95Ms: 200, errorRatePct: 0.5, availabilityPct: 99.9, wrs: 92 };

describe('evaluateAcceptance', () => {
  it('returns null when no criteria are set', () => {
    expect(evaluateAcceptance(undefined, metrics)).toBeNull();
    expect(evaluateAcceptance({}, metrics)).toBeNull();
    expect(hasCriteria({})).toBe(false);
  });

  it('PASS when every criterion is met', () => {
    const r = evaluateAcceptance(
      { maxP95Ms: 500, maxErrorRatePct: 1, minAvailabilityPct: 99, minWrs: 80 },
      metrics,
    );
    expect(r).toEqual({ verdict: 'PASS', failures: [] });
  });

  it('FAIL lists each breached criterion', () => {
    const r = evaluateAcceptance(
      { maxP95Ms: 100, maxErrorRatePct: 0.1, minAvailabilityPct: 100, minWrs: 95 },
      metrics,
    )!;
    expect(r.verdict).toBe('FAIL');
    expect(r.failures).toHaveLength(4);
    expect(r.failures[0]).toContain('p95 latency');
  });
});

describe('createCampaign acceptance validation', () => {
  const base: CampaignInput = {
    name: 'x',
    target: 'http://localhost/',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 2,
    maxDurationSec: 10,
    probeUrl: 'http://localhost/',
    createdBy: 'e',
    authorized: true,
  };
  it('accepts valid criteria', () => {
    const c = createCampaign({ ...base, acceptance: { maxP95Ms: 500, minWrs: 80 } }, ['localhost']);
    expect(c.acceptance?.maxP95Ms).toBe(500);
  });
  it('rejects an out-of-range percentage', () => {
    expect(() =>
      createCampaign({ ...base, acceptance: { minAvailabilityPct: 150 } }, ['localhost']),
    ).toThrow(CampaignError);
  });
});

describe('buildSuites verdict aggregation', () => {
  const c = (over: Partial<Campaign>): Campaign =>
    ({
      id: Math.random().toString(36).slice(2),
      name: 'n',
      target: 'https://h/',
      probeUrl: 'https://h/',
      vector: 'http-get',
      maxRps: 10,
      concurrency: 2,
      maxDurationSec: 10,
      createdBy: 'e',
      authorized: true,
      status: 'COMPLETED',
      createdAt: '2026-01-01T00:00:00Z',
      suiteId: 's1',
      suiteName: 'Suite',
      ...over,
    }) as Campaign;

  it('is FAIL if any member failed its SLO', () => {
    const [s] = buildSuites([
      c({ suiteOrder: 0, acceptanceResult: { verdict: 'PASS', failures: [] } }),
      c({ suiteOrder: 1, acceptanceResult: { verdict: 'FAIL', failures: ['x'] } }),
    ]);
    expect(s.verdict).toBe('FAIL');
  });
  it('is PASS if judged and none failed; null if none judged', () => {
    const [pass] = buildSuites([
      c({ suiteOrder: 0, acceptanceResult: { verdict: 'PASS', failures: [] } }),
    ]);
    expect(pass.verdict).toBe('PASS');
    const [none] = buildSuites([c({ suiteOrder: 0 })]);
    expect(none.verdict).toBeNull();
  });
});
