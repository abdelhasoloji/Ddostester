import { describe, it, expect } from 'vitest';
import {
  admittedCapacity,
  deriveEnvelope,
  levelReachability,
  type AgentCapacity,
} from '../src/modules/drs/capacity.js';

const agent = (id: string, tps: number, concurrency = tps / 10): AgentCapacity => ({
  id,
  measuredTps: tps,
  measuredConcurrency: concurrency,
  measuredAt: '2026-10-19T20:00:00.000Z',
});

const scope = (maxRps: number, maxConcurrency: number) => ({
  maxRps,
  maxConcurrency,
  maxDurationSec: 120,
  targets: ['http://lab-target:8080/'],
});

const ceiling = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };

/** Same grammar as the scoring parser: 200K, 25M, 100G. */
const quantity = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)$/.exec(raw);
  return m
    ? Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2]] ?? NaN)
    : null;
};

describe('admitted capacity', () => {
  it('ignores an agent that was never calibrated', () => {
    const c = admittedCapacity([agent('one', 1000), { ...agent('two', 5000), measuredAt: '' }]);
    expect(c.admitted.map((a) => a.id)).toEqual(['one']);
    expect(c.excluded).toEqual(['two']);
  });

  it('applies the derating to the sum', () => {
    const c = admittedCapacity([agent('a', 1000), agent('b', 1000)], 0.5);
    expect(c.tps).toBe(1000);
    expect(c.concurrency).toBe(100);
  });
});

describe('derived envelope', () => {
  it('is bounded by the signed scope when the fleet is larger', () => {
    const e = deriveEnvelope({ scope: scope(500, 50), agents: [agent('a', 10_000)], ceiling });
    expect(e.maxRps).toBe(500);
    expect(e.limitedBy.rps).toBe('scope');
    expect(e.warnings).toEqual([]);
  });

  it('is bounded by measured capacity and says so', () => {
    const e = deriveEnvelope({ scope: scope(200_000, 500), agents: [agent('a', 1000)], ceiling });
    expect(e.maxRps).toBe(800); // 1000 × 0.8
    expect(e.limitedBy.rps).toBe('capacity');
    expect(e.warnings.join(' ')).toContain('admitted capacity is 800');
  });

  it('is bounded by the service ceiling, never silently raised', () => {
    const e = deriveEnvelope({
      scope: scope(50_000, 500),
      agents: [agent('a', 100_000)],
      ceiling,
    });
    expect(e.maxRps).toBe(2000);
    expect(e.limitedBy.rps).toBe('ceiling');
    expect(e.warnings.join(' ')).toContain('SERVICE_CEILING');
  });

  it('refuses to derive a useful envelope with no admitted agent', () => {
    const e = deriveEnvelope({ scope: scope(500, 50), agents: [], ceiling });
    expect(e.maxRps).toBe(0);
    expect(e.agents).toBe(0);
    expect(e.warnings.join(' ')).toContain('capacity is zero');
  });
});

describe('level reachability', () => {
  const vectors: {
    internal_id: string;
    level: number;
    load_requirements: Record<string, string>;
    service_requirements: Record<string, string>;
  }[] = [
    {
      internal_id: 'http-get',
      level: 1,
      load_requirements: { vol_tps: '500' },
      service_requirements: { max_bots: '10' },
    },
    {
      internal_id: 'udp-flood',
      level: 1,
      load_requirements: { vol_bps: '100G' },
      service_requirements: { max_bots: '10' },
    },
  ];

  it('marks a vector reachable only when load and source count are covered', () => {
    const [level] = levelReachability(vectors, { maxRps: 500, agents: 10 }, { quantity });
    expect(level.total).toBe(2);
    expect(level.reachable).toBe(1);
    expect(level.unreachable[0].vectorId).toBe('udp-flood');
    expect(level.unreachable[0].missing.join(' ')).toContain('no generator for this unit');
  });

  it('reports the tps gap and the bot gap with numbers', () => {
    const [level] = levelReachability(vectors, { maxRps: 100, agents: 3 }, { quantity });
    expect(level.reachable).toBe(0);
    const http = level.unreachable.find((u) => u.vectorId === 'http-get')!;
    expect(http.missing.join(' ')).toContain('500 tps (envelope 100)');
    expect(http.missing.join(' ')).toContain('10 bots (3 admitted)');
  });
});
