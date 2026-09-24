import { describe, expect, it } from 'vitest';
import { filterSuites, sortSuites, SUITE_PROGRESS_FILTERS } from './pages.js';
import type { SuiteSummary } from './api.js';

type WrsLevel = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

function suite(over: Partial<SuiteSummary> & { suiteId: string }): SuiteSummary {
  return {
    suiteId: over.suiteId,
    suiteName: over.suiteName ?? 'Suite',
    target: over.target ?? 'https://bank.cz/',
    createdAt: over.createdAt ?? '2026-09-24T10:00:00.000Z',
    total: over.total ?? 2,
    pending: over.pending ?? 0,
    approved: over.approved ?? 0,
    running: over.running ?? 0,
    completed: over.completed ?? 2,
    members: over.members ?? [],
    wrs: over.wrs ?? null,
    verdict: over.verdict ?? null,
  };
}
const wrs = (min: number, level: WrsLevel) => ({ avg: min, min, level, scored: 1 });

describe('filterSuites', () => {
  const list: SuiteSummary[] = [
    suite({
      suiteId: 'run',
      suiteName: 'Alpha',
      running: 1,
      pending: 0,
      completed: 1,
      wrs: wrs(97, 'A+'),
    }),
    suite({
      suiteId: 'pend',
      suiteName: 'Bravo',
      running: 0,
      pending: 1,
      completed: 1,
      wrs: wrs(70, 'C'),
      verdict: 'FAIL',
    }),
    suite({
      suiteId: 'done',
      suiteName: 'Charlie',
      target: 'https://46.28.109.92/',
      running: 0,
      pending: 0,
      completed: 2,
      wrs: wrs(85, 'B'),
      verdict: 'PASS',
    }),
    suite({ suiteId: 'raw', suiteName: 'Delta', running: 0, pending: 0, completed: 2, wrs: null }),
  ];
  const base = { progress: 'all' as const, q: '', level: 'all', verdict: 'all' };

  it('progress filter splits running / pending / done', () => {
    expect(filterSuites(list, { ...base, progress: 'running' }).map((s) => s.suiteId)).toEqual([
      'run',
    ]);
    expect(filterSuites(list, { ...base, progress: 'pending' }).map((s) => s.suiteId)).toEqual([
      'pend',
    ]);
    expect(
      filterSuites(list, { ...base, progress: 'done' })
        .map((s) => s.suiteId)
        .sort(),
    ).toEqual(['done', 'raw']);
  });
  it('search matches name or target (case-insensitive)', () => {
    expect(filterSuites(list, { ...base, q: 'brav' }).map((s) => s.suiteId)).toEqual(['pend']);
    expect(filterSuites(list, { ...base, q: '46.28' }).map((s) => s.suiteId)).toEqual(['done']);
  });
  it('WRS level filter, incl. "not scored"', () => {
    expect(filterSuites(list, { ...base, level: 'B' }).map((s) => s.suiteId)).toEqual(['done']);
    expect(filterSuites(list, { ...base, level: 'none' }).map((s) => s.suiteId)).toEqual(['raw']);
  });
  it('verdict filter', () => {
    expect(filterSuites(list, { ...base, verdict: 'FAIL' }).map((s) => s.suiteId)).toEqual([
      'pend',
    ]);
    expect(filterSuites(list, { ...base, verdict: 'PASS' }).map((s) => s.suiteId)).toEqual([
      'done',
    ]);
  });
  it('has the same chip set as the Campaign table (All/Running/Pending/Done)', () => {
    expect(SUITE_PROGRESS_FILTERS.map((f) => f.label)).toEqual([
      'All',
      'Running',
      'Pending',
      'Done',
    ]);
  });
});

describe('sortSuites', () => {
  const list: SuiteSummary[] = [
    suite({
      suiteId: 'a',
      suiteName: 'Zulu',
      createdAt: '2026-09-20T10:00:00Z',
      wrs: wrs(90, 'A'),
      verdict: 'PASS',
    }),
    suite({
      suiteId: 'b',
      suiteName: 'Alpha',
      createdAt: '2026-09-24T10:00:00Z',
      wrs: wrs(60, 'D'),
      verdict: 'FAIL',
    }),
  ];
  it('name asc', () => {
    expect(sortSuites(list, 'name', 'asc').map((s) => s.suiteName)).toEqual(['Alpha', 'Zulu']);
  });
  it('wrs asc puts the worst first', () => {
    expect(sortSuites(list, 'wrs', 'asc').map((s) => s.suiteId)).toEqual(['b', 'a']);
  });
  it('recent desc puts the newest first', () => {
    expect(sortSuites(list, 'recent', 'desc').map((s) => s.suiteId)).toEqual(['b', 'a']);
  });
  it('verdict asc puts FAIL before PASS', () => {
    expect(sortSuites(list, 'verdict', 'asc').map((s) => s.suiteId)).toEqual(['b', 'a']);
  });
  it('does not mutate the input array', () => {
    const copy = [...list];
    sortSuites(list, 'name', 'asc');
    expect(list).toEqual(copy);
  });
});
