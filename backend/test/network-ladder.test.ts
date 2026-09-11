import { describe, it, expect } from 'vitest';
import { buildNetworkLadder } from '../src/modules/reports/gap-analysis.js';
import { BENCH_SCENARIOS, type BenchCoverage } from '../src/modules/bench/model.js';

const cov = (over: Partial<BenchCoverage>): BenchCoverage =>
  ({
    id: 'x',
    vector: 'udp_dns_reflection',
    method: 'BENCH_EMITTED',
    summary: 's',
    source: 'network-team-bench',
    recordedBy: 'ops',
    at: '2026-09-11T00:00:00Z',
    ...over,
  }) as BenchCoverage;

describe('buildNetworkLadder', () => {
  it('places every network scenario on its DRS tier, all uncovered with no evidence', () => {
    const l = buildNetworkLadder([]);
    expect(l.total).toBe(BENCH_SCENARIOS.length);
    expect(l.covered).toBe(0);
    expect(l.weakest).toBeUndefined();
    const placed = l.tiers.flatMap((t) => t.vectors);
    expect(placed).toHaveLength(BENCH_SCENARIOS.length);
    expect(placed.every((v) => v.status === 'uncovered')).toBe(true);
    expect(l.tiers.every((t) => t.verdict === 'uncovered')).toBe(true);
    // Tiers are ordered DRS ascending.
    expect(l.tiers.map((t) => t.drs)).toEqual([...l.tiers.map((t) => t.drs)].sort((a, b) => a - b));
  });

  it('marks an absorbed vector and reports no weakest link when there is no gap', () => {
    const l = buildNetworkLadder([cov({ vector: 'udp_dns_reflection', outcome: 'MITIGATED' })]);
    expect(l.covered).toBe(1);
    expect(l.weakest).toBeUndefined();
    const v = l.tiers.flatMap((t) => t.vectors).find((x) => x.id === 'udp_dns_reflection');
    expect(v?.status).toBe('absorbed');
  });

  it('flags a gap and picks the lowest-DRS gap as the network weakest link', () => {
    const l = buildNetworkLadder([
      cov({ vector: 'tcp_synflood', outcome: 'NOT_MITIGATED' }), // DRS 3
      cov({ vector: 'ip_spoofing', outcome: 'NOT_MITIGATED' }), // DRS 4
    ]);
    expect(l.weakest?.drs).toBe(3);
    expect(l.weakest?.id).toBe('tcp_synflood');
    const tier3 = l.tiers.find((t) => t.drs === 3);
    expect(tier3?.verdict).toBe('gap');
  });

  it('keeps only the latest verdict per scenario', () => {
    const l = buildNetworkLadder([
      cov({ vector: 'udp_dns_reflection', outcome: 'NOT_MITIGATED', at: '2026-09-10T00:00:00Z' }),
      cov({ vector: 'udp_dns_reflection', outcome: 'MITIGATED', at: '2026-09-11T00:00:00Z' }),
    ]);
    expect(l.covered).toBe(1);
    expect(l.weakest).toBeUndefined(); // the newer MITIGATED wins → no gap
  });
});
