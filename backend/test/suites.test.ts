import { describe, expect, it } from 'vitest';
import { buildSuites, renderSuiteReportHtml } from '../src/modules/playbooks/suites.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { WrsBreakdown } from '../src/modules/wrs/scoring.js';

function wrs(v: number, level: WrsBreakdown['level']): WrsBreakdown {
  return { detection: v, mitigation: v, availability: v, collateral: v, wrs: v, level };
}

function campaign(over: Partial<Campaign>): Campaign {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'c',
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    vector: 'http-get',
    maxRps: 100,
    concurrency: 10,
    maxDurationSec: 60,
    createdBy: 'e',
    authorized: true,
    status: 'PENDING_APPROVAL',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Campaign;
}

describe('buildSuites', () => {
  it('groups by suiteId, orders members and aggregates WRS', () => {
    const campaigns = [
      campaign({
        suiteId: 's1',
        suiteName: 'Capacity',
        suiteOrder: 1,
        status: 'COMPLETED',
        wrs: wrs(70, 'B'),
      }),
      campaign({
        suiteId: 's1',
        suiteName: 'Capacity',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(90, 'A'),
      }),
      campaign({ suiteId: 's1', suiteName: 'Capacity', suiteOrder: 2, status: 'APPROVED' }),
      campaign({ id: 'lone' }), // no suite
    ];
    const suites = buildSuites(campaigns);
    expect(suites).toHaveLength(1);
    const s = suites[0];
    expect(s.total).toBe(3);
    expect(s.members.map((m) => m.order)).toEqual([0, 1, 2]);
    expect(s.completed).toBe(2);
    expect(s.approved).toBe(1);
    expect(s.wrs).toEqual({ avg: 80, min: 70, level: 'B', scored: 2 });
  });

  it('returns null aggregate when no member is scored', () => {
    const suites = buildSuites([campaign({ suiteId: 's2', suiteName: 'x', suiteOrder: 0 })]);
    expect(suites[0].wrs).toBeNull();
  });
});

describe('renderSuiteReportHtml', () => {
  it('renders target, aggregate and one row per step', () => {
    const [s] = buildSuites([
      campaign({
        suiteId: 's1',
        suiteName: 'Capacity',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(90, 'A'),
      }),
      campaign({
        suiteId: 's1',
        suiteName: 'Capacity',
        suiteOrder: 1,
        status: 'COMPLETED',
        wrs: wrs(60, 'C'),
      }),
    ]);
    const html = renderSuiteReportHtml(s);
    expect(html).toContain('Assessment report — Capacity');
    expect(html).toContain('staging.example.com');
    expect(html).toContain('75'); // avg of 90 and 60
    expect(html).toContain('worst level C');
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(3); // header + 2 steps
  });
});
