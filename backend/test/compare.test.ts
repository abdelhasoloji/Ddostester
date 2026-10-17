import { describe, expect, it } from 'vitest';
import { renderCompareHtml, compareRuns } from '../src/modules/reports/compare.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

// Hypothetical complete evidence for positive comparison tests. These fixtures
// do not certify any real runtime or target.
function knownConfig() {
  return {
    url: 'https://bank.cz/',
    concurrency: 2,
    durationSec: 10,
    maxRps: 100,
    authorized: true,
    execution: {
      engine: 'builtin-http',
      runtime: 'v22.23.3',
      sourceRef: 'snapshot:' + 'a'.repeat(64),
      probeUrl: 'https://bank.cz/health',
      probeVantage: 'local' as const,
    },
  };
}

function campaign(id: string, name: string, target: string): Campaign {
  return { id, name, target } as unknown as Campaign;
}
function run(
  campaignId: string,
  o: {
    wrs: number;
    level: string;
    available: number;
    samples: number;
    p95: number;
    status?: CampaignRun['status'];
    protection?: { source?: string; detectionTimeSec: number; mitigationTimeSec: number };
  },
): CampaignRun {
  return {
    runId: `${campaignId}-run`,
    campaignId,
    status: o.status ?? 'COMPLETED',
    wrs: { wrs: o.wrs, level: o.level, estimated: false },
    confidence: { degraded: false, reasons: [] },
    assessment: { verdict: 'held' },
    probe: {
      samples: o.samples,
      available: o.available,
      latencyMs: { p50: 0, p95: o.p95, p99: 0 },
    },
    generator: { config: knownConfig(), actualRps: 100, finishedAt: new Date().toISOString() },
    protection: o.protection,
  } as unknown as CampaignRun;
}

describe('before/after comparison report', () => {
  const cBefore = campaign('c1', 'Baseline (before DRS)', 'https://bank.cz/');
  const cAfter = campaign('c2', 'Baseline (after DRS)', 'https://bank.cz/');

  it('reports "Improved" and per-metric deltas when B beats A', () => {
    const a = {
      campaign: cBefore,
      run: run('c1', { wrs: 60, level: 'C', available: 80, samples: 100, p95: 120 }),
    };
    const b = {
      campaign: cAfter,
      run: run('c2', {
        wrs: 92,
        level: 'A',
        available: 100,
        samples: 100,
        p95: 45,
        protection: { source: 'scrubbing', detectionTimeSec: 4, mitigationTimeSec: 11 },
      }),
    };
    const html = renderCompareHtml(a, b);
    expect(html).toContain('Resilience comparison');
    expect(html).toContain('Improved (+32 WRS)');
    expect(html).toContain('+32'); // WRS delta
    expect(html).toContain('+20 pts'); // availability delta
    expect(html).toMatch(/▼ -75 ms/); // p95 improved (down is good)
    expect(html).toContain('4s'); // TTD after
    expect(html).toContain('11s'); // TTM after
  });

  it('reports "Regressed" when B is worse than A', () => {
    const a = {
      campaign: cBefore,
      run: run('c1', { wrs: 90, level: 'A', available: 100, samples: 100, p95: 40 }),
    };
    const b = {
      campaign: cAfter,
      run: run('c2', {
        wrs: 55,
        level: 'C',
        available: 90,
        samples: 100,
        p95: 80,
        status: 'KILLED_AUTO',
      }),
    };
    const html = renderCompareHtml(a, b);
    expect(html).toContain('Regressed (-35 WRS)');
  });
});

// --- Structured comparison (Mitigation Proof) --------------------------------

function rich(
  campaignId: string,
  o: {
    wrs: number;
    level: string;
    available: number;
    samples: number;
    p95: number;
    status?: CampaignRun['status'];
    fivexx?: number;
    absorbedPct?: number;
  },
): CampaignRun {
  return {
    runId: `${campaignId}-run`,
    campaignId,
    status: o.status ?? 'COMPLETED',
    wrs: { wrs: o.wrs, level: o.level, estimated: false },
    confidence: { degraded: false, reasons: [] },
    assessment: { verdict: 'held' },
    probe: {
      samples: o.samples,
      available: o.available,
      latencyMs: { p50: 0, p95: o.p95, p99: 0 },
    },
    generator: {
      config: knownConfig(),
      actualRps: 100,
      finishedAt: new Date().toISOString(),
      statusCounts: o.fivexx === undefined ? undefined : { '5xx': o.fivexx, '2xx': 10 },
    },
    absorption: o.absorbedPct === undefined ? undefined : { absorbedPct: o.absorbedPct },
  } as unknown as CampaignRun;
}

describe('compareRuns (structured Mitigation Proof)', () => {
  const cA = campaign('c1', 'bank.cz — before mitigation', 'https://bank.cz/');
  const cB = campaign('c2', 'bank.cz — after mitigation', 'https://bank.cz/');

  it('withholds improvement for changed profiles, budgets, unknown or degraded evidence', () => {
    const before = rich('c1', { wrs: 40, level: 'D', available: 100, samples: 100, p95: 50 });
    const after = rich('c2', { wrs: 95, level: 'A', available: 100, samples: 100, p95: 30 });
    const variants = [
      () => {
        after.generator.config.maxRps = 1;
      },
      () => {
        after.generator.config.iotProfile = { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 0 };
      },
      () => {
        after.generator.config.execution = undefined;
      },
      () => {
        after.generator.config.execution!.sourceRef = 'dev';
      },
      () => {
        after.generator.config.execution!.engine = 'k6';
      },
      () => {
        after.generator.config.execution!.runtime = 'v24.19.0';
      },
      () => {
        after.generator.config.execution!.probeUrl = 'https://bank.cz/other-health';
      },
      () => {
        after.status = 'KILLED_MANUAL';
      },
      () => {
        after.confidence!.degraded = true;
      },
      () => {
        after.wrs.estimated = true;
      },
      () => {
        after.wrs.wrs = NaN;
      },
      () => {
        after.assessment = undefined;
      },
    ];
    const original = structuredClone(after);
    for (const change of variants) {
      Object.assign(after, structuredClone(original));
      change();
      const cmp = compareRuns({ campaign: cA, run: before }, { campaign: cB, run: after });
      expect(cmp.verdict).toBe('inconclusive');
      expect(cmp.comparability.reasons.length).toBeGreaterThan(0);
      expect(cmp.metrics.every((metric) => metric.improved === null)).toBe(true);
      const html = renderCompareHtml({ campaign: cA, run: before }, { campaign: cB, run: after });
      expect(html).toContain('Comparison inconclusive');
      expect(html).not.toContain('Improved (');
      expect(html).toContain('(descriptive)');
    }
  });

  it('ignores per-run trace tags but compares functional headers and runtime versions', () => {
    const before = rich('c1', { wrs: 40, level: 'D', available: 100, samples: 100, p95: 50 });
    const after = rich('c2', { wrs: 95, level: 'A', available: 100, samples: 100, p95: 30 });
    before.generator.config.headers = { 'X-WEDOS-TEST': 'run-one' };
    after.generator.config.headers = { 'X-WEDOS-TEST': 'run-two' };
    expect(compareRuns({ campaign: cA, run: before }, { campaign: cB, run: after }).verdict).toBe(
      'improved',
    );
    after.generator.config.headers['content-type'] = 'application/json';
    expect(compareRuns({ campaign: cA, run: before }, { campaign: cB, run: after }).verdict).toBe(
      'inconclusive',
    );
  });

  it('verdicts "improved" and computes per-metric deltas incl. origin 5xx', () => {
    const cmp = compareRuns(
      {
        campaign: cA,
        run: rich('c1', {
          wrs: 41,
          level: 'D',
          available: 33,
          samples: 100,
          p95: 4973,
          status: 'KILLED_AUTO',
          fivexx: 11252,
          absorbedPct: 20,
        }),
      },
      {
        campaign: cB,
        run: rich('c2', {
          wrs: 97,
          level: 'A+',
          available: 100,
          samples: 100,
          p95: 40,
          fivexx: 0,
          absorbedPct: 96,
        }),
      },
    );
    expect(cmp.verdict).toBe('improved');
    expect(cmp.wrsDelta).toBe(56);
    expect(cmp.levelBefore).toBe('D');
    expect(cmp.levelAfter).toBe('A+');
    expect(cmp.target).toBe('bank.cz');
    expect(cmp.headline).toMatch(/improved/);
    expect(cmp.headline).toContain('D→A+');

    const byKey = Object.fromEntries(cmp.metrics.map((m) => [m.key, m]));
    expect(byKey.origin5xx).toMatchObject({ before: 11252, after: 0, improved: true }); // down = good
    expect(byKey.latencyP95).toMatchObject({ before: 4973, after: 40, improved: true });
    expect(byKey.availability).toMatchObject({ before: 33, after: 100, improved: true });
    expect(byKey.absorbedPct).toMatchObject({ before: 20, after: 96, improved: null });
    expect(byKey.wrs.improved).toBe(true);
  });

  it('verdicts "regressed" when B is worse, and lists remediations for it', () => {
    const cmp = compareRuns(
      {
        campaign: cA,
        run: rich('c1', { wrs: 92, level: 'A', available: 100, samples: 100, p95: 40 }),
      },
      {
        campaign: cB,
        run: rich('c2', {
          wrs: 41,
          level: 'D',
          available: 0,
          samples: 100,
          p95: 5000,
          status: 'KILLED_AUTO',
        }),
      },
    );
    expect(cmp.verdict).toBe('regressed');
    expect(cmp.remainingRemediations.length).toBeGreaterThan(0);
  });

  it('verdicts "unchanged" for a sub-threshold move at the same level', () => {
    const cmp = compareRuns(
      {
        campaign: cA,
        run: rich('c1', { wrs: 90, level: 'A', available: 100, samples: 100, p95: 40 }),
      },
      {
        campaign: cB,
        run: rich('c2', { wrs: 91, level: 'A', available: 100, samples: 100, p95: 41 }),
      },
    );
    expect(cmp.verdict).toBe('unchanged');
  });

  it('a level change drives the verdict even on a small WRS move', () => {
    const cmp = compareRuns(
      {
        campaign: cA,
        run: rich('c1', { wrs: 55, level: 'C', available: 95, samples: 100, p95: 60 }),
      },
      {
        campaign: cB,
        run: rich('c2', { wrs: 57, level: 'B', available: 96, samples: 100, p95: 55 }),
      },
    );
    expect(cmp.verdict).toBe('improved'); // +2 WRS is sub-threshold, but C→B is a level up
  });

  it('is null-safe when a run lacks absorption / status counts', () => {
    const cmp = compareRuns(
      {
        campaign: cA,
        run: rich('c1', { wrs: 60, level: 'C', available: 90, samples: 100, p95: 100 }),
      },
      {
        campaign: cB,
        run: rich('c2', { wrs: 70, level: 'B', available: 95, samples: 100, p95: 80 }),
      },
    );
    const byKey = Object.fromEntries(cmp.metrics.map((m) => [m.key, m]));
    expect(byKey.origin5xx).toMatchObject({
      before: null,
      after: null,
      delta: null,
      improved: null,
    });
    expect(byKey.absorbedPct).toMatchObject({ before: null, after: null, improved: null });
  });
});

it('does not turn absent probe observations into 100% availability or 0ms latency', () => {
  const campaignA = campaign('a', 'before', 'https://bank.cz/');
  const a = run('a', { wrs: 90, level: 'A', available: 0, samples: 0, p95: 0 });
  const b = run('b', { wrs: 90, level: 'A', available: 100, samples: 100, p95: 10 });
  const comparison = compareRuns({ campaign: campaignA, run: a }, { campaign: campaignA, run: b });
  for (const key of ['availability', 'latencyP95'])
    expect(comparison.metrics.find((m) => m.key === key)).toMatchObject({
      before: null,
      delta: null,
      improved: null,
    });
  expect(
    renderCompareHtml({ campaign: campaignA, run: a }, { campaign: campaignA, run: b }),
  ).toContain('Not measured');
});

it('retains small availability differences before calculating the delta', () => {
  const c = campaign('a', 'probe', 'https://bank.cz/');
  const a = run('a', { wrs: 90, level: 'A', available: 998, samples: 1000, p95: 10 });
  const b = run('b', { wrs: 90, level: 'A', available: 999, samples: 1000, p95: 10 });
  expect(
    compareRuns({ campaign: c, run: a }, { campaign: c, run: b }).metrics.find(
      (m) => m.key === 'availability',
    ),
  ).toMatchObject({ before: 99.8, after: 99.9, delta: 0.1 });
});

it('does not compare different campaign targets even when the cached workloads match', () => {
  const a = run('a', { wrs: 60, level: 'C', samples: 100, available: 100, p95: 10 });
  const b = run('b', { wrs: 97, level: 'A+', samples: 100, available: 100, p95: 10 });
  const x = compareRuns(
    { campaign: campaign('a', 'a', 'https://bank.cz/'), run: a },
    { campaign: campaign('b', 'b', 'https://different.invalid/'), run: b },
  );
  expect(x.verdict).toBe('inconclusive');
  expect(x.comparability.reasons).toContain('campaign targets differ');
});
