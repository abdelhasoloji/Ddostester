import { describe, expect, it } from 'vitest';
import {
  evaluateSloGate,
  metricsFromRun,
  sloGateConfigFromEnv,
} from '../src/modules/campaigns/slogate.js';
import type { AcceptanceMetrics } from '../src/modules/campaigns/acceptance.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

const ok: AcceptanceMetrics = {
  p95Ms: 120,
  errorRatePct: 0.5,
  availabilityPct: 99.5,
  wrs: 92,
  assertionFailurePct: 0,
};

describe('evaluateSloGate', () => {
  it('passes when every threshold is met', () => {
    const v = evaluateSloGate(ok, { minWrs: 80, maxP95Ms: 200, minAvailabilityPct: 99 });
    expect(v.pass).toBe(true);
    expect(v.verdict).toBe('PASS');
    expect(v.reasons).toEqual([]);
  });

  it('fails and lists each unmet SLO', () => {
    const v = evaluateSloGate(ok, { minWrs: 95, maxP95Ms: 100 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toHaveLength(2);
    expect(v.reasons.join(' ')).toMatch(/WRS/);
    expect(v.reasons.join(' ')).toMatch(/p95/);
  });

  it('fails on a WRS regression beyond the tolerance band', () => {
    const v = evaluateSloGate(ok, { regressionTolerancePoints: 10 }, 110);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toMatch(/regression/);
  });

  it('tolerates a WRS dip within the band', () => {
    const v = evaluateSloGate(ok, { regressionTolerancePoints: 10 }, 100);
    expect(v.pass).toBe(true);
  });

  it('skips the regression check when there is no previous WRS', () => {
    expect(evaluateSloGate(ok, { regressionTolerancePoints: 10 }).pass).toBe(true);
  });

  it('passes when no thresholds are configured at all', () => {
    expect(evaluateSloGate(ok, {}).pass).toBe(true);
  });
});

describe('metricsFromRun', () => {
  it('derives the acceptance metrics from a run', () => {
    const run = {
      generator: {
        totalRequests: 1000,
        failed: 10,
        latencyMs: { p95: 150 },
        assertionsChecked: 200,
        assertionFailures: 4,
      },
      probe: { samples: 100, available: 98 },
      wrs: { wrs: 88 },
    } as unknown as CampaignRun;
    const m = metricsFromRun(run);
    expect(m.p95Ms).toBe(150);
    expect(m.errorRatePct).toBeCloseTo(1);
    expect(m.availabilityPct).toBeCloseTo(98);
    expect(m.wrs).toBe(88);
    expect(m.assertionFailurePct).toBeCloseTo(2);
  });
});

describe('sloGateConfigFromEnv', () => {
  it('parses configured thresholds and ignores blanks', () => {
    const cfg = sloGateConfigFromEnv({
      SLO_MIN_WRS: '80',
      SLO_MAX_P95_MS: '500',
      SLO_REGRESSION_TOLERANCE_PTS: '10',
      SLO_MAX_ERROR_RATE_PCT: '',
    } as NodeJS.ProcessEnv);
    expect(cfg.minWrs).toBe(80);
    expect(cfg.maxP95Ms).toBe(500);
    expect(cfg.regressionTolerancePoints).toBe(10);
    expect(cfg.maxErrorRatePct).toBeUndefined();
  });
});
