import { describe, it, expect } from 'vitest';
import { inferProfile } from '../src/modules/reports/gap-analysis.js';
import type { PostureReport } from '../src/modules/posture/analyze.js';
import type { AbsorptionSummaryRow } from '../src/modules/observability/summary.js';
import type { BenchCoverage } from '../src/modules/bench/model.js';

const posture = (over: Partial<PostureReport> = {}): PostureReport =>
  ({
    waf: false,
    cdn: false,
    rateLimiting: false,
    loadBalancer: false,
    hsts: false,
    securityHeaders: [],
    signals: [],
    ...over,
  }) as PostureReport;

const row = (over: Partial<AbsorptionSummaryRow>): AbsorptionSummaryRow => ({
  target: 'bank.cz',
  vector: 'http-get',
  runs: 1,
  meanWrs: 0,
  lastAbsorbedPct: 0,
  meanAbsorbedPct: 0,
  lastRejectedPct: 0,
  lastTarpitPct: 0,
  lastOfferedShortfallPct: 0,
  ...over,
});

const cov = (over: Partial<BenchCoverage>): BenchCoverage =>
  ({
    id: 'x',
    vector: 'udp_dns_reflection', // a real DRS-3 BENCH_SCENARIOS id
    method: 'BENCH_EMITTED',
    summary: 's',
    source: 'network-team-bench',
    recordedBy: 'ops',
    at: new Date().toISOString(),
    ...over,
  }) as BenchCoverage;

describe('inferProfile', () => {
  it('is empty and safe with no evidence', () => {
    const r = inferProfile({});
    expect(r.profile).toEqual({});
    expect(r.provenance).toEqual({});
  });

  it('seeds from recon posture (present only)', () => {
    const r = inferProfile({ posture: posture({ waf: true, cdn: true, rateLimiting: true }) });
    expect(r.profile.rateLimiting).toBe('present');
    expect(r.profile.wafSignatures).toBe('present');
    expect(r.profile.originShielding).toBe('present');
    expect(r.provenance.rateLimiting?.[0].source).toBe('recon');
  });

  it('reads controls from prior-run absorption mechanics', () => {
    const r = inferProfile({
      absorption: [row({ lastRejectedPct: 62, lastTarpitPct: 41 })],
    });
    expect(r.profile.rateLimiting).toBe('unknown'); // HTTP failures → rate limiting
    expect(r.profile.slowRequestTimeout).toBe('unknown'); // tarpitted → slow-request handling
    expect(r.provenance.rateLimiting?.[0].source).toBe('run');
  });

  it('keeps imported lab handling outcomes separate from target SYN-protection claims', () => {
    const present = inferProfile({ labCoverage: [cov({ outcome: 'MITIGATED' })] });
    expect(present.profile.synFloodProtection).toBe('unknown');

    const absent = inferProfile({ labCoverage: [cov({ outcome: 'NOT_MITIGATED' })] });
    expect(absent.profile.synFloodProtection).toBe('unknown');
    expect(absent.provenance.synFloodProtection?.[0].source).toBe('lab');
  });

  it('resolves a control to its strongest source (lab > run > recon) and keeps all provenance', () => {
    // rateLimiting seen by recon AND runs → resolved value comes from the run
    // (stronger), and both pieces of evidence are recorded.
    const r = inferProfile({
      posture: posture({ rateLimiting: true }),
      absorption: [row({ lastRejectedPct: 80 })],
    });
    expect(r.profile.rateLimiting).toBe('unknown');
    const sources = r.provenance.rateLimiting?.map((e) => e.source) ?? [];
    expect(sources).toContain('recon');
    expect(sources).toContain('run');
  });
});
