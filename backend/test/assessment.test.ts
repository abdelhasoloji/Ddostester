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
  /** Intended mean offered rate (delivery denominator); defaults to cfg (constant). */
  expected?: number;
}): Absorption {
  const expectedRps = o.expected ?? o.cfg;
  return {
    configuredRps: o.cfg,
    expectedRps,
    achievedRps: o.ach,
    originRps: o.origin ?? o.ach,
    absorbedRatio: o.absorbed ?? 0,
    absorbedPct: Math.round((o.absorbed ?? 0) * 1000) / 10,
    totalRequests: 1000,
    offeredShortfall: Math.max(0, 1 - o.ach / expectedRps),
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
  calibration?: CampaignRun['calibration'];
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
    calibration: o.calibration,
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
    expect(va.observation).toMatch(/successful HTTP responses/i);
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
    expect(va.observation).toMatch(/attribution unavailable/i);
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

describe('assessVector — delivery is measured against the intended mean, not the peak', () => {
  it('a faithfully-delivered WAVE (mean ~73% of peak) is held, not inconclusive', () => {
    // Peak 800, wave mean 586; delivered 570 — a perfect wave, NOT under-delivery.
    // Measured against the peak (570/800 = 71%) it would clear only barely; against
    // the intended mean (570/586 = 97%) it is comfortably valid.
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 800, expected: 586, ach: 570, absorbed: 0 }),
      }),
      ctx({ shape: 'L7 MultiVector (DRS5)', drs: '5' }),
    );
    expect(va.expectedRps).toBe(586);
    expect(va.deliveryRatio).toBeCloseTo(570 / 586, 3);
    expect(va.underDelivered).toBe(false);
    expect(va.verdict).toBe('held');
  });

  it('a faithfully-delivered RAMP (mean ~58% of peak) is held — no longer a false inconclusive', () => {
    // The latent bug this fixes: at the peak, 583/1000 = 58% < 0.7 → inconclusive.
    // Against the intended mean (583/583 = 100%) it is a valid held.
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 1000, expected: 583, ach: 583, absorbed: 0 }),
      }),
      ctx({ shape: 'Ramp-plateau (DRS4)', drs: '4' }),
    );
    expect(va.underDelivered).toBe(false);
    expect(va.verdict).toBe('held');
  });

  it('a genuine shortfall below the intended mean is still inconclusive', () => {
    // Wave mean 586 but only 300 delivered (51% of the mean) → real shortfall.
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 800, expected: 586, ach: 300, absorbed: 0 }),
      }),
      ctx({ shape: 'L7 MultiVector (DRS5)', drs: '5' }),
    );
    expect(va.underDelivered).toBe(true);
    expect(va.verdict).toBe('inconclusive');
    expect(va.caveats.join(' ')).toMatch(/intended offered rate/);
  });
});

describe('assessVector — rate-calibrated runs are valid AND disclosed (GEN-1)', () => {
  it('a calibrated run grades a VALID verdict at the applied rate, not inconclusive', () => {
    // THOR: requested 1000, calibrated to 650; absorption.configuredRps is the
    // APPLIED rate (app.ts), so delivery reads ~100% and the verdict is valid.
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 650, ach: 650, absorbed: 0 }),
        calibration: { requestedRps: 1000, deliveredRps: 650, appliedRps: 650, calibrated: true },
      }),
      ctx({ shape: 'THOR / PulseWave (DRS5)', drs: '5' }),
    );
    expect(va.underDelivered).toBe(false);
    expect(va.verdict).toBe('held'); // valid, not inconclusive
    // But it is disclosed: a caveat + an observation note name the calibrated rate.
    expect(va.caveats.join(' ')).toMatch(/Rate-calibrated/);
    expect(va.caveats.join(' ')).toMatch(/1000 req\/s/); // requested
    expect(va.caveats.join(' ')).toMatch(/650 req\/s/); // applied
    expect(va.observation).toMatch(/graded at 650 req\/s/);
    expect(va.observation).toMatch(/not the requested 1000/);
  });

  it('a run where the burst confirmed the rate (calibrated:false) adds no calibration caveat', () => {
    const va = assessVector(
      mkRun({
        availCount: 100,
        absorption: abs({ cfg: 800, ach: 790, absorbed: 0 }),
        calibration: { requestedRps: 800, deliveredRps: 790, appliedRps: 800, calibrated: false },
      }),
      ctx({ drs: '4' }),
    );
    expect(va.caveats.join(' ')).not.toMatch(/Rate-calibrated/);
    expect(va.observation).not.toMatch(/graded at/);
  });
});

describe('assessVector — breach vs probe contention', () => {
  it('a real auto-kill is a breach', () => {
    const va = assessVector(
      mkRun({ status: 'KILLED_AUTO', availCount: 10, statusDetail: 'availability floor breached' }),
      ctx({ status: 'KILLED_AUTO' }),
    );
    expect(va.verdict).toBe('breached');
    expect(va.observation).toMatch(/Automatic stop/);
  });

  it('an auto-kill under probe contention is inconclusive, not a breach', () => {
    const va = assessVector(
      mkRun({ status: 'KILLED_AUTO', availCount: 10, probeContended: true }),
      ctx({ status: 'KILLED_AUTO' }),
    );
    expect(va.verdict).toBe('inconclusive');
  });

  it('a completed run that collapsed legit availability below 50% is breached, not just partial', () => {
    // The Capacity-ceiling run: tarpitted the origin, legit availability 40%, but it
    // completed (no auto-kill). 40% available = unavailable the majority of the run.
    const va = assessVector(
      mkRun({
        availCount: 40,
        absorption: abs({ cfg: 800, ach: 800, absorbed: 0.806, tar: 0.806 }),
      }),
      ctx({ shape: 'Capacity ceiling', drs: '4' }),
    );
    expect(va.verdict).toBe('breached');
    expect(va.mechanism).toBe('tarpitted');
    expect(va.observation).toMatch(/40% of completed legitimate probe transactions succeeded/);
  });

  it('a mild availability dip (≥50%) stays partial, not breached', () => {
    const va = assessVector(
      mkRun({ availCount: 60, absorption: abs({ cfg: 800, ach: 790, absorbed: 0 }) }),
      ctx(),
    );
    expect(va.verdict).toBe('partial');
  });

  it('a low-availability run under probe contention is NOT breached (false negative guarded)', () => {
    const va = assessVector(
      mkRun({ availCount: 40, probeContended: true, absorption: abs({ cfg: 800, ach: 800 }) }),
      ctx(),
    );
    expect(va.verdict).not.toBe('breached');
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

it('keeps automatic safety stop but withholds an outage verdict when remote baseline is missing', () => {
  const run = mkRun({ status: 'KILLED_AUTO', availCount: 10 });
  run.baseline = {
    samples: 3,
    availabilityPct: 0,
    latencyMs: { p50: 0, p95: 0 },
    observation: {
      vantage: 'remote',
      expectedSamples: 3,
      receivedSamples: 0,
      missingSamples: 3,
      complete: false,
    },
  };
  expect(assessVector(run, ctx({ status: 'KILLED_AUTO' })).verdict).toBe('inconclusive');
  expect(run.status).toBe('KILLED_AUTO');
});

it('does not describe absent run evidence as zero availability', () => {
  const result = assessVector(undefined, { shape: 'HTTP/2', drs: '3', status: 'APPROVED' });
  expect(result.verdict).toBe('inconclusive');
  expect(result.observation).toContain('unknown');
  expect(result.observation).not.toContain('0%');
});

it('does not pass an absent probe or an unconfirmed HTTP/2 protocol', () => {
  const run = mkRun({});
  run.probe.samples = 0;
  expect(assessVector(run, ctx()).verdict).toBe('inconclusive');
  expect(assessVector(run, ctx()).observation).toContain('unknown');
  const h2 = assessVector(mkRun({}), { ...ctx({ shape: 'HTTP/2 GET' }), h2Confirmed: false });
  expect(h2.verdict).toBe('inconclusive');
  expect(h2.caveats.join(' ')).toContain('HTTP/2 was not confirmed');
});

it('cannot turn inconsistent probe counts or a degraded automatic stop into an attributed breach', () => {
  const invalid = mkRun({ availCount: 110 });
  const ctx = { shape: 'bounded HTTP', drs: '3', status: 'COMPLETED', vector: 'http-get' };
  expect(assessVector(invalid, ctx)).toMatchObject({
    verdict: 'inconclusive',
    availabilityPct: null,
  });
  const degraded = mkRun({
    status: 'KILLED_AUTO',
    availCount: 0,
    confidence: { degraded: true, reasons: ['probe resource contention'] },
  });
  expect(assessVector(degraded, { ...ctx, status: 'KILLED_AUTO' }).verdict).toBe('inconclusive');
});
