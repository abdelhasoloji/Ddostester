import { describe, expect, it } from 'vitest';
import {
  buildSuites,
  renderSuiteReportHtml,
  renderSuiteCompareHtml,
} from '../src/modules/playbooks/suites.js';
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
    expect(html).toContain('L7 resilience'); // report title (target-named, no "Pre-test")
    expect(html).toContain('DDoS resilience assessment'); // zeroBS-style cover
    expect(html).toContain('staging.example.com');
    expect(html).toContain('75'); // avg of 90 and 60
    expect(html).toContain('worst C'); // worst level
    expect(html).toContain('Management summary');
    expect(html).toContain('Layer 7 summary');
    expect(html).toContain('Verdict'); // verdict-driven summary
    expect(html).toContain('Glossary');
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(3); // steps + glossary rows
  });

  it('links to Grafana when a base URL is configured', () => {
    const [s] = buildSuites([
      campaign({
        suiteId: 'g1',
        suiteName: 'Cap',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(90, 'A'),
      }),
    ]);
    const html = renderSuiteReportHtml(s, [], { grafanaUrl: 'http://localhost:3000' });
    expect(html).toContain('Open this run in Grafana');
    expect(html).toContain('/d/shieldtest-run?');
    // no inline availability SVG figure when Grafana is the chart source
    expect(html).not.toContain('Legitimate-probe availability across the attack');
  });
});

describe('renderSuiteCompareHtml', () => {
  const step = (over: Partial<Campaign>) =>
    campaign({ suiteName: 'CRA L7', target: 'https://bank.cz/', ...over });

  const [before] = buildSuites([
    step({
      suiteId: 'before',
      suiteOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
      status: 'COMPLETED',
      wrs: wrs(60, 'C'),
      acceptanceResult: { verdict: 'FAIL' } as Campaign['acceptanceResult'],
    }),
    step({
      suiteId: 'before',
      suiteOrder: 1,
      createdAt: '2026-01-01T00:00:00Z',
      status: 'COMPLETED',
      wrs: wrs(80, 'B'),
      acceptanceResult: { verdict: 'PASS' } as Campaign['acceptanceResult'],
    }),
  ]);
  const [after] = buildSuites([
    step({
      suiteId: 'after',
      suiteOrder: 0,
      createdAt: '2026-02-01T00:00:00Z',
      status: 'COMPLETED',
      wrs: wrs(85, 'A'),
      acceptanceResult: { verdict: 'PASS' } as Campaign['acceptanceResult'],
    }),
    step({
      suiteId: 'after',
      suiteOrder: 1,
      createdAt: '2026-02-01T00:00:00Z',
      status: 'COMPLETED',
      wrs: wrs(75, 'B'),
      acceptanceResult: { verdict: 'PASS' } as Campaign['acceptanceResult'],
    }),
  ]);

  it('pairs by order and shows per-line WRS/verdict deltas', () => {
    const html = renderSuiteCompareHtml(before, after);
    expect(html).toContain('Suite comparison');
    expect(html).toContain('CRA L7');
    expect(html).toContain('bank.cz');
    // step 0 improved 60→85 and its verdict was fixed; step 1 regressed 80→75.
    expect(html).toContain('1</b> step(s) improved');
    expect(html).toContain('1</b> regressed');
    expect(html).toContain('fixed');
    expect(html).toContain('worst-step WRS <b>60</b> → <b>75</b>');
  });

  it('tolerates a step scored on only one side', () => {
    const [partial] = buildSuites([
      step({ suiteId: 'p', suiteOrder: 0, status: 'APPROVED' }), // unscored
    ]);
    const html = renderSuiteCompareHtml(before, partial);
    expect(html).toContain('Suite comparison');
    expect(html).toContain('—'); // unscored side rendered as a dash
  });
});
