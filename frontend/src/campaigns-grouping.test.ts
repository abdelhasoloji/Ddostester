import { describe, expect, it } from 'vitest';
import { fmtDur, groupSuites, suiteTiming, suiteWrs } from './pages.js';
import type { Campaign } from './api.js';

function campaign(over: Partial<Campaign>): Campaign {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'step',
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/health',
    vector: 'http-get',
    status: 'COMPLETED',
    createdBy: 'eng@wedos',
    maxRps: 100,
    concurrency: 10,
    maxDurationSec: 60,
    ...over,
  } as Campaign;
}

describe('fmtDur', () => {
  it('formats seconds, minutes and hours', () => {
    expect(fmtDur(0)).toBe('0s');
    expect(fmtDur(45)).toBe('45s');
    expect(fmtDur(75)).toBe('1m 15s');
    expect(fmtDur(120)).toBe('2m');
    expect(fmtDur(3900)).toBe('1h 5m');
  });
  it('renders a dash for missing/invalid input', () => {
    expect(fmtDur(undefined)).toBe('—');
    expect(fmtDur(-1)).toBe('—');
  });
});

describe('suiteTiming', () => {
  it('spans first start to last finish and sums on-target time', () => {
    const members = [
      campaign({
        startedAt: '2026-09-09T10:00:00Z',
        finishedAt: '2026-09-09T10:01:00Z',
        durationSec: 60,
      }),
      campaign({
        startedAt: '2026-09-09T10:02:00Z',
        finishedAt: '2026-09-09T10:05:00Z',
        durationSec: 180,
      }),
    ];
    const t = suiteTiming(members);
    expect(t.start).toBe('2026-09-09T10:00:00Z');
    expect(t.end).toBe('2026-09-09T10:05:00Z');
    expect(t.wallSec).toBe(300); // 10:00 → 10:05
    expect(t.runSec).toBe(240); // 60 + 180
  });

  it('falls back to createdAt when a step never ran', () => {
    const t = suiteTiming([campaign({ status: 'APPROVED', createdAt: '2026-09-09T09:00:00Z' })]);
    expect(t.start).toBe('2026-09-09T09:00:00Z');
    expect(t.end).toBeUndefined();
    expect(t.wallSec).toBeUndefined();
    expect(t.runSec).toBe(0);
  });
});

describe('suiteWrs', () => {
  const wrs = (v: number, level: string) =>
    ({ detection: v, mitigation: v, availability: v, collateral: v, wrs: v, level }) as never;

  it('averages scored members and reports the worst', () => {
    const agg = suiteWrs([
      campaign({ wrs: wrs(90, 'A') }),
      campaign({ wrs: wrs(60, 'C') }),
      campaign({ status: 'APPROVED' }), // unscored — ignored
    ]);
    expect(agg).toEqual({ avg: 75, min: 60, level: 'C', scored: 2 });
  });

  it('returns null when nothing is scored', () => {
    expect(suiteWrs([campaign({ status: 'APPROVED' })])).toBeNull();
  });
});

describe('groupSuites', () => {
  it('groups by suiteId and leaves standalone campaigns out', () => {
    const groups = groupSuites([
      campaign({ suiteId: 's1', suiteName: 'CRA L7', suiteOrder: 1 }),
      campaign({ suiteId: 's1', suiteName: 'CRA L7', suiteOrder: 0 }),
      campaign({ id: 'lone' }), // no suiteId
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].total).toBe(2);
    expect(groups[0].members.map((m) => m.suiteOrder)).toEqual([0, 1]);
  });
});
