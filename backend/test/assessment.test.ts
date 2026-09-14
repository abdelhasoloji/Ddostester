import { describe, it, expect } from 'vitest';
import { assessVector, assessSuite } from '../src/modules/reports/assessment.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import type { Absorption } from '../src/modules/reports/absorption.js';

/** Minimal absorption with sane derived fields. */
function abs(o: {
  cfg: number;
  ach: number;
  origin?: number;
  absorbed?: number;
  rej?: number;
  tar?: number;
}): Absorption {
  return {
    configuredRps: o.cfg,
    achievedRps: o.ach,
    originRps: o.origin ?? o.ach,
    absorbedRatio: o.absorbed ?? 0,
    absorbedPct: Math.round((o.absorbed ?? 0) * 1000) / 10,
    totalRequests: 1000,
    offeredShortfall: Math.max(0, 1 - o.ach / o.cfg),
    rejectedRatio: o.rej ?? 0,
    tarpitRatio: o.tar ?? 0,
  };
}

/** A completed run with the fields the assessment engine reads. */
function mkRun(o: {
  status?: CampaignRun['status'];
  availCount?: number; // out of 100 samples
  absorption?: Absorption;
  confidence?: CampaignRun['confidence'];
  probeContended?: boolean;
  statusDetail?: string;
  wrs?: number;
}): CampaignRun {
  const avail = o.availCount ?? 100;
  return {
    runId: 'r',
    campaignId: 'c',
    status: o.status ?? 'COMPLETED',
    statusDetail: o.statusDetail,
    generator: {
      id: 'r',
      actualRps: o.absorption?.achievedRps ?? 100,
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
      samples: 100,
      available: avail,
      errorRate5xx: 0,
      latencyMs: { p50: 0, p95: 0, p99: 0 },
      successful: avail,
    },
    probeContended: o.probeContended,
    wrs: {
      wrs: o.wrs ?? 97,
      level: 'A+',
      detection: 0,
      mitigation: 0,
      availability: 0,
      collateral: 0,
    },
    absorption: o.absorption,
    confidence: o.confidence,
  } as unknown as CampaignRun;
}

const ctx = (
  over: Partial<{ shape: string; drs: string; status: string; vector: string }> = {},
) => ({
  shape: over.shape ?? 'GET-Flood (DRS3)',
  drs: over.drs ?? '3',
  status: over.status ?? 'COMPLETED',
  vector: over.vector,
});

describe('assessVector — mechanism (grounded on absorption, never statusCounts)', () => {
  it('origin served the load → mechanism "served", partial when availability dipped', () => {
    const va = assessVector(
      mkRun({ availCount: 96, absorption: abs({ cfg: 800, ach: 790, absorbed: 0 }) }),
      ctx(),
    );
    expect(va.mechanism).toBe('served');
    expect(va.verdict).toBe('partial');
    expect(va.observation).toMatch(/origin served the load/i);
    expect(va.observation).not.toMatch(/rejecting/i); // the old bug
  });

  it('edge rejected with 4xx/5xx → mechanism "rejected", held at 100% availability', () => {
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 400, ach: 400, absorbed: 0.999, rej: 0.999 }),
      }),
      ctx(),
    );
    expect(va.mechanism).toBe('rejected');
    expect(va.verdict).toBe('held');
  });

  it('blocked with no per-status breakdown (external engine) → mechanism "blocked", honest text', () => {
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 400, ach: 400, absorbed: 0.5, rej: 0, tar: 0 }),
      }),
      ctx(),
    );
    expect(va.mechanism).toBe('blocked');
    expect(va.observation).toMatch(/mechanism not resolved/i);
  });
});

describe('assessVector — under-delivery is inconclusive, not a pass', () => {
  it('delivered 18% of the target rate → inconclusive with a caveat', () => {
    const va = assessVector(
      mkRun({ availCount: 100, absorption: abs({ cfg: 800, ach: 141, absorbed: 0.001 }) }),
      ctx({ drs: '5' }),
    );
    expect(va.underDelivered).toBe(true);
    expect(va.verdict).toBe('inconclusive');
    expect(va.confident).toBe(false);
    expect(va.caveats.join(' ')).toMatch(/delivered only/i);
    expect(va.observation).toMatch(/INCONCLUSIVE/);
  });

  it('slow-connection vector is exempt from the rate check', () => {
    const va = assessVector(
      mkRun({ availCount: 100, absorption: abs({ cfg: 10, ach: 1, absorbed: 1, tar: 1 }) }),
      ctx({ shape: 'SlowLoris (DRS3)' }),
    );
    expect(va.isSlowConnection).toBe(true);
    expect(va.underDelivered).toBe(false);
    expect(va.mechanism).toBe('shed');
    expect(va.verdict).toBe('held');
  });
});

describe('assessVector — breach vs probe contention', () => {
  it('a real auto-kill is a breach', () => {
    const va = assessVector(
      mkRun({ status: 'KILLED_AUTO', availCount: 10, statusDetail: 'availability floor breached' }),
      ctx({ status: 'KILLED_AUTO' }),
    );
    expect(va.verdict).toBe('breached');
    expect(va.observation).toMatch(/Not mitigated/);
  });

  it('an auto-kill under probe contention is inconclusive, not a breach', () => {
    const va = assessVector(
      mkRun({ status: 'KILLED_AUTO', availCount: 10, probeContended: true }),
      ctx({ status: 'KILLED_AUTO' }),
    );
    expect(va.verdict).toBe('inconclusive');
  });

  it('a generator-degraded run is inconclusive even at 100% availability', () => {
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 400, ach: 400, absorbed: 0 }),
        confidence: { degraded: true, reasons: ['event-loop lag peaked'], peakEventLoopLagMs: 180 },
      }),
      ctx(),
    );
    expect(va.verdict).toBe('inconclusive');
    expect(va.confident).toBe(false);
  });
});

describe('assessSuite — worst-case aggregation', () => {
  it('counts verdicts, worst risk and a meaningful headline', () => {
    const vectors = [
      assessVector(
        mkRun({
          availCount: 100,
          absorption: abs({ cfg: 400, ach: 400, absorbed: 0.9, rej: 0.9 }),
          wrs: 97,
        }),
        ctx(),
      ),
      assessVector(
        mkRun({ availCount: 96, absorption: abs({ cfg: 800, ach: 790, absorbed: 0 }), wrs: 90 }),
        ctx(),
      ),
      assessVector(
        mkRun({ status: 'KILLED_AUTO', availCount: 10, wrs: 40 }),
        ctx({ status: 'KILLED_AUTO' }),
      ),
      assessVector(
        mkRun({ availCount: 100, absorption: abs({ cfg: 800, ach: 100, absorbed: 0 }), wrs: 95 }),
        ctx({ drs: '5' }),
      ),
    ];
    const sa = assessSuite(vectors);
    expect(sa.held).toBe(1);
    expect(sa.partial).toBe(1);
    expect(sa.breached).toBe(1);
    expect(sa.inconclusive).toBe(1);
    expect(sa.validAtRate).toBe(2); // held + partial were confident; breach & under-delivered are not
    expect(sa.worstRisk).toBe('Critical');
    expect(sa.worstWrs).toBe(40);
    expect(sa.headline).toMatch(/Worst WRS 40/);
    expect(sa.headline).toMatch(/inconclusive/);
  });
});
