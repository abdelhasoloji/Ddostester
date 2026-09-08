import { describe, expect, it } from 'vitest';
import {
  analyzeGaps,
  postureToProfile,
  renderGapAnalysisHtml,
} from '../src/modules/reports/gap-analysis.js';
import type { PostureReport } from '../src/modules/posture/analyze.js';

describe('analyzeGaps', () => {
  it('splits bounded (plan) from attestation-only lines', () => {
    const a = analyzeGaps({});
    // 11 bounded lines in pretest-cra-l7; 3 out-of-model (TCP, WAF-cracker, brute-force).
    expect(a.plan).toHaveLength(11);
    expect(a.attestationOnly.map((x) => x.line).sort((p, q) => p - q)).toEqual([1, 12, 14]);
    expect(a.summary.attested).toBe(3);
  });

  it('ranks by DRS level and how weakly the control is declared', () => {
    const a = analyzeGaps({ slowRequestTimeout: 'present', rateLimiting: 'absent' });
    // SlowLoris (DRS3, control present) drops to low priority…
    const slow = a.plan.find((p) => p.name === 'SlowLoris');
    expect(slow?.priority).toBe('low');
    // …while the GET-Flood line (DRS3, rate limiting ABSENT) ranks above it.
    const getFlood = a.plan.find((p) => p.name === 'HTTP GET-Flood');
    expect(getFlood!.score).toBeGreaterThan(slow!.score);
    // Plan is sorted highest score first.
    for (let i = 1; i < a.plan.length; i++) {
      expect(a.plan[i - 1].score).toBeGreaterThanOrEqual(a.plan[i].score);
    }
  });

  it('every plan item names a concrete step to replay', () => {
    const a = analyzeGaps({});
    expect(a.plan.every((p) => p.step.length > 0)).toBe(true);
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
  it('renders both tables and the priority summary', () => {
    const html = renderGapAnalysisHtml(analyzeGaps({ rateLimiting: 'absent' }, 'bank.cz'));
    expect(html).toContain('Protection-gap analysis');
    expect(html).toContain('bank.cz');
    expect(html).toContain('Prioritised replay plan');
    expect(html).toContain('Attestation-only');
    expect(html).toContain('WAF-Cracker'); // attested line present
    expect(html).toContain('pill'); // priority pills rendered
  });
});
