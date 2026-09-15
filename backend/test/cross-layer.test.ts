import { describe, it, expect } from 'vitest';
import {
  BENCH_SCENARIOS,
  CLASS_C_LADDERS,
  benchLadderScenarios,
  isKnownBenchScenario,
} from '../src/modules/bench/model.js';
import { crossLayerAssurance } from '../src/modules/reports/gap-analysis.js';
import { PLAYBOOKS } from '../src/modules/playbooks/playbooks.js';
import type { BenchCoverage } from '../src/modules/bench/model.js';

describe('class-C synthetic scenarios (new, no-spoof)', () => {
  const NEW = [
    'udp_ntp_reflection',
    'udp_ssdp_reflection',
    'udp_cldap_reflection',
    'udp_memcached_reflection',
    'quic_init_pressure',
    'tcp_conn_drain',
    'pulsewave_l34',
  ];
  it('are all present, reproducible and dispatchable', () => {
    for (const id of NEW) {
      const s = BENCH_SCENARIOS.find((x) => x.id === id);
      expect(s, id).toBeTruthy();
      expect(s!.reproducible, id).toBe(true);
      expect(isKnownBenchScenario(id), id).toBe(true);
    }
  });
  it('keeps the spoofing/crafting vectors NON-reproducible (the boundary holds)', () => {
    for (const id of ['ip_spoofing', 'udp_fragmentation', 'tcp_fragmentation', 'gre_packets']) {
      expect(BENCH_SCENARIOS.find((x) => x.id === id)!.reproducible, id).toBe(false);
      expect(isKnownBenchScenario(id), id).toBe(false);
    }
  });
});

describe('benchLadderScenarios', () => {
  it('resolves the DRS 3→5 network ladder to reproducible scenarios only', () => {
    const s = benchLadderScenarios('network-drs345');
    expect(s.length).toBe(CLASS_C_LADDERS[0].scenarios.length);
    expect(s.every((x) => x.reproducible)).toBe(true);
    // DRS is non-decreasing along the ladder (an ordered 3→5 escalation).
    for (let i = 1; i < s.length; i++) expect(s[i].drs).toBeGreaterThanOrEqual(s[i - 1].drs);
  });
  it('throws on an unknown ladder', () => {
    expect(() => benchLadderScenarios('nope')).toThrow(/unknown bench ladder/);
  });
  it('every curated ladder references only known reproducible scenarios', () => {
    for (const l of CLASS_C_LADDERS) expect(() => benchLadderScenarios(l.id)).not.toThrow();
  });
});

const cov = (over: Partial<BenchCoverage>): BenchCoverage => ({
  id: `c-${Math.random()}`,
  vector: 'udp_dns_reflection',
  method: 'lab' as never,
  outcome: 'MITIGATED',
  summary: 'x',
  source: 'network-team-bench',
  recordedBy: 'ciso@wedos',
  at: new Date().toISOString(),
  ...over,
});

describe('crossLayerAssurance (fuse a ladder with lab coverage)', () => {
  it('marks absorbed / gap / uncovered per vector and finds the lowest-DRS gap', () => {
    const coverage: BenchCoverage[] = [
      cov({ vector: 'udp_dns_reflection', outcome: 'MITIGATED' }), // absorbed
      cov({ vector: 'tcp_synflood', outcome: 'NOT_MITIGATED' }), // gap (DRS3)
      cov({ vector: 'pulsewave_l34', outcome: 'FAIL' }), // gap (DRS5)
    ];
    const a = crossLayerAssurance('network-drs345', coverage);
    expect(a.total).toBe(benchLadderScenarios('network-drs345').length);
    const byId = Object.fromEntries(a.vectors.map((v) => [v.id, v.status]));
    expect(byId['udp_dns_reflection']).toBe('absorbed');
    expect(byId['tcp_synflood']).toBe('gap');
    expect(byId['udp_ntp_reflection']).toBe('uncovered'); // no coverage recorded
    expect(a.covered).toBe(1);
    expect(a.gaps).toBe(2);
    // The weakest link is the LOWEST-DRS gap (tcp_synflood @ DRS3), not the DRS5 one.
    expect(a.weakest?.id).toBe('tcp_synflood');
    expect(a.weakest?.drs).toBe(3);
  });

  it('uses the most recent coverage per vector', () => {
    const a = crossLayerAssurance('network-drs345', [
      cov({ vector: 'udp_dns_reflection', outcome: 'NOT_MITIGATED', at: '2026-01-01T00:00:00Z' }),
      cov({ vector: 'udp_dns_reflection', outcome: 'MITIGATED', at: '2026-06-01T00:00:00Z' }),
    ]);
    expect(a.vectors.find((v) => v.id === 'udp_dns_reflection')!.status).toBe('absorbed');
  });

  it('is empty-safe (no coverage → everything uncovered, no weakest)', () => {
    const a = crossLayerAssurance('network-drs345', []);
    expect(a.uncovered).toBe(a.total);
    expect(a.covered).toBe(0);
    expect(a.weakest).toBeUndefined();
  });
});

describe('playbook companionBench (cross-layer templates)', () => {
  it('P26-20371 and the cross-layer template declare a valid class-C companion ladder', () => {
    for (const id of ['pretest-cra-l7', 'xlayer-full-assurance']) {
      const pb = PLAYBOOKS.find((p) => p.id === id);
      expect(pb, id).toBeTruthy();
      expect(pb!.companionBench, id).toBeTruthy();
      // The declared ladder must resolve (only known reproducible scenarios).
      expect(() => benchLadderScenarios(pb!.companionBench!.ladder)).not.toThrow();
    }
  });
});
