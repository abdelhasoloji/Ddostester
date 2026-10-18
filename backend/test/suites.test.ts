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
    expect(html).toContain('DDoS resilience assessment'); // DRS-style cover
    expect(html).toContain('staging.example.com');
    expect(html).toContain('75'); // avg of 90 and 60
    expect(html).toContain('worst C'); // worst level
    expect(html).toContain('Management summary');
    expect(html).toContain('Layer 7 summary');
    expect(html).toContain('Verdict'); // verdict-driven summary
    expect(html).toContain('Glossary');
    expect(html).toContain('DRS NOT_EVALUATED');
    expect(html).toContain('Load (configured→mean)');
    expect(html).not.toContain('took the target unavailable');
    expect(html).not.toContain('Legitimate traffic held throughout');
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThanOrEqual(3); // steps + glossary rows
  });

  it('flags an applicability caveat for a step whose target lacks a required feature', () => {
    const [s] = buildSuites([
      campaign({
        suiteId: 'na1',
        suiteName: 'Threat',
        name: 'Threat — HTTP/2 burst',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(95, 'A'),
        requires: ['h2'],
        reconPosture: { h2: false, waf: false, cache: false, dynamic: true },
      }),
    ]);
    const html = renderSuiteReportHtml(s);
    expect(html).toContain('Applicability caveats');
    expect(html).toContain('HTTP/2');
    expect(html).toContain('not evidence the target resisted');
  });

  it('renders no applicability caveat when every requirement is satisfied', () => {
    const [s] = buildSuites([
      campaign({
        suiteId: 'na2',
        suiteName: 'Threat',
        name: 'Threat — cache stress',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(80, 'B'),
        requires: ['cache'],
        reconPosture: { h2: false, waf: false, cache: true, dynamic: false },
      }),
    ]);
    expect(renderSuiteReportHtml(s)).not.toContain('Applicability caveats');
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
    // Grafana is demoted to a small secondary access-gated link (loopback-only).
    expect(html).toContain('/d/shieldtest-run?');
    expect(html).toContain('requires access to the Grafana instance');
  });

  it('draws pertinent inline charts (offered load + availability) from the run timeline', () => {
    const [s] = buildSuites([
      campaign({
        id: 'cic1',
        runId: 'r-ic',
        suiteId: 'ic1',
        suiteName: 'Cap',
        suiteOrder: 0,
        status: 'COMPLETED',
        wrs: wrs(90, 'A'),
      }),
    ]);
    const runs = [
      {
        runId: 'r-ic',
        campaignId: 'cic1',
        status: 'COMPLETED',
        generator: {
          actualRps: 100,
          totalRequests: 1000,
          successful: 1000,
          failed: 0,
          statusCounts: {},
          latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
          errors: {},
          startedAt: '2026-09-14T10:00:00.000Z',
          finishedAt: '2026-09-14T10:01:00.000Z',
        },
        probe: {
          samples: 10,
          available: 10,
          errorRate5xx: 0,
          latencyMs: { p50: 0, p95: 0, p99: 0 },
          successful: 10,
        },
        wrs: { wrs: 90, level: 'A', detection: 0, mitigation: 0, availability: 0, collateral: 0 },
        timeline: Array.from({ length: 6 }, (_, t) => ({
          t,
          rps: 100,
          sent: t * 100,
          failed: 0,
          probe5xx: 0,
          availPct: 100,
        })),
      },
    ] as unknown as Parameters<typeof renderSuiteReportHtml>[1];
    const html = renderSuiteReportHtml(s, runs);
    expect(html).toContain('Emitted requests per interval (req/s)');
    expect(html).toContain('Probe availability (cumulative %;');
    expect(html).toContain('chart-timeline'); // an inline SVG, not just a link
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
    expect(html).toContain('1</b> step score(s) increased');
    expect(html).toContain('1</b> decreased');
    expect(html).toContain('recorded SLO FAIL→PASS');
    expect(html).toContain('Comparison inconclusive');
    expect(html).not.toContain('means better protection');
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

it('retains execution diagnostics without fabricating missing measurements', () => {
  const [suite] = buildSuites([
    campaign({
      suiteId: 'failed',
      status: 'APPROVED',
      statusDetail: 'Last run failed (reference diagnostic-123); review before retrying.',
    }),
  ]);
  const html = renderSuiteReportHtml(suite, []);
  expect(html).toContain('diagnostic-123');
  expect(html).toContain('Not measured');
  expect(html).not.toContain('availability dipped to 0%');
});

it('cannot report a suite-wide SLO pass from only one judged step', () => {
  const [suite] = buildSuites([
    campaign({
      suiteId: 'partial-slo',
      suiteOrder: 0,
      status: 'COMPLETED',
      acceptanceResult: { verdict: 'PASS' } as Campaign['acceptanceResult'],
    }),
    campaign({ suiteId: 'partial-slo', suiteOrder: 1, status: 'APPROVED' }),
  ]);
  expect(suite.verdict).toBeNull();
});
