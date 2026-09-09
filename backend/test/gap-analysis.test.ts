import { describe, expect, it } from 'vitest';
import {
  analyzeGaps,
  postureToProfile,
  renderGapAnalysisHtml,
  drsTier,
} from '../src/modules/reports/gap-analysis.js';
import type { PostureReport } from '../src/modules/posture/analyze.js';

describe('analyzeGaps', () => {
  it('splits bounded (ladder) from attestation-only lines', () => {
    const a = analyzeGaps({});
    expect(a.plan).toHaveLength(11);
    expect(a.attestationOnly.map((x) => x.line).sort((p, q) => p - q)).toEqual([1, 12, 14]);
    expect(a.summary.attested).toBe(3);
  });

  it('lays the plan out as a DRS escalation ladder (ascending)', () => {
    const a = analyzeGaps({});
    for (let i = 1; i < a.plan.length; i++) {
      expect(a.plan[i].drs).toBeGreaterThanOrEqual(a.plan[i - 1].drs);
    }
    expect(a.plan[0].tier).toBe(drsTier(3));
  });

  it('coverage follows the weakest link of the control chain', () => {
    // GET-Random-Flood mitigated by [originShielding, rateLimiting]; with origin
    // shielding present but rate limiting absent, the weakest link is absent.
    const a = analyzeGaps({ originShielding: 'present', rateLimiting: 'absent' });
    const randomFlood = a.plan.find((p) => p.name === 'GET-Random-Flood')!;
    expect(randomFlood.weakest.key).toBe('rateLimiting');
    expect(randomFlood.weakest.status).toBe('absent');
    expect(randomFlood.controls).toHaveLength(2);
  });

  it('ranks a fully-declared low-DRS line as low priority', () => {
    const a = analyzeGaps({ slowRequestTimeout: 'present' });
    const slow = a.plan.find((p) => p.name === 'SlowLoris')!;
    expect(slow.weakest.status).toBe('present');
    expect(slow.priority).toBe('low');
  });

  it('predicts the earliest gap on the ladder as the break point', () => {
    // Only rate limiting absent → the first rate-limited rung (GET-Flood, DRS3) breaks.
    const a = analyzeGaps({ rateLimiting: 'absent' });
    expect(a.breakPoint?.line).toBe(3);
    expect(a.breakPoint?.weakest.key).toBe('rateLimiting');
  });

  it('flags the DRS5 combination lines and carries capped intensity', () => {
    const a = analyzeGaps({});
    const multi = a.plan.find((p) => p.name === 'HTTP MultiVector')!;
    expect(multi.combination).toBe(true);
    // Intensity is sourced from the real pretest-cra-l7 step.
    expect(multi.intensity).toBeTruthy();
    expect(multi.intensity!.maxRps).toBeGreaterThan(0);
    expect(a.plan.every((p) => p.step.length > 0)).toBe(true);
  });

  it('reports no break point when every control is declared present', () => {
    const full = Object.fromEntries(
      (
        [
          'synFloodProtection',
          'slowRequestTimeout',
          'rateLimiting',
          'originShielding',
          'cacheKeyPolicy',
          'urlAllowlist',
          'methodPolicy',
          'http2Guard',
          'challenge',
          'wafSignatures',
          'bruteForceProtection',
        ] as const
      ).map((k) => [k, 'present' as const]),
    );
    const a = analyzeGaps(full);
    expect(a.breakPoint).toBeNull();
  });

  it('carries the target through', () => {
    expect(analyzeGaps({}, 'bank.cz').target).toBe('bank.cz');
  });
});

describe('postureToProfile', () => {
  it('sets only positively-observed controls to present, leaves the rest unknown', () => {
    const posture: PostureReport = {
      waf: true,
      cdn: false,
      rateLimiting: true,
      loadBalancer: false,
      hsts: true,
      securityHeaders: ['content-security-policy'],
      signals: [],
    };
    const p = postureToProfile(posture);
    expect(p.rateLimiting).toBe('present');
    expect(p.wafSignatures).toBe('present');
    expect(p.originShielding).toBeUndefined(); // cdn was false → not asserted
  });
});

describe('renderGapAnalysisHtml', () => {
  it('renders the ladder, break point and attestation table', () => {
    const html = renderGapAnalysisHtml(analyzeGaps({ rateLimiting: 'absent' }, 'bank.cz'));
    expect(html).toContain('Protection-gap analysis');
    expect(html).toContain('bank.cz');
    expect(html).toContain('escalation ladder');
    expect(html).toContain('break point');
    expect(html).toContain('WAF-Cracker'); // attested line present
    expect(html).toContain('combo'); // combination lines flagged
  });
});
