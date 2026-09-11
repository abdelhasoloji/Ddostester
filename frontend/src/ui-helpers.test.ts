import { describe, expect, it } from 'vitest';
import {
  buildAcceptance,
  buildAssertion,
  buildScenario,
  formatInterval,
  fmtDateTime,
  hostOf,
  parseDataset,
  parseEndpoints,
  parseFlow,
  parseFlowJson,
  wrsClass,
} from './ui.js';

describe('wrsClass', () => {
  it('maps levels to CSS classes (A+ → wrs-Ap)', () => {
    expect(wrsClass('A+')).toBe('wrs-Ap');
    expect(wrsClass('B')).toBe('wrs-B');
  });
});

describe('hostOf', () => {
  it('returns the hostname or null', () => {
    expect(hostOf('https://staging.wedos/health')).toBe('staging.wedos');
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('formatInterval', () => {
  it('renders whole hours as h, else minutes', () => {
    expect(formatInterval(60)).toBe('1 h');
    expect(formatInterval(360)).toBe('6 h');
    expect(formatInterval(30)).toBe('30 min');
  });
});

describe('fmtDateTime', () => {
  it('formats a valid ISO date and dashes out missing/invalid input', () => {
    expect(fmtDateTime('2026-09-11T12:37:00Z')).not.toBe('—');
    expect(fmtDateTime(undefined)).toBe('—');
    expect(fmtDateTime('not a date')).toBe('—');
  });
});

describe('buildScenario', () => {
  it('is undefined for constant, 3 rising phases for ramp, spike-lull-spike for wave', () => {
    expect(buildScenario('constant', 100, 60)).toBeUndefined();
    const ramp = buildScenario('ramp', 400, 180)!;
    expect(ramp).toHaveLength(3);
    expect(ramp[0].maxRps).toBeLessThan(ramp[2].maxRps);
    const wave = buildScenario('wave', 500, 180)!;
    expect(wave[0].maxRps).toBeGreaterThan(wave[1].maxRps);
  });
});

describe('buildAcceptance', () => {
  const empty = { sloP95: '', sloErr: '', sloAvail: '', sloWrs: '', sloAssert: '' };
  it('returns undefined when nothing set', () => {
    expect(buildAcceptance(empty)).toBeUndefined();
  });
  it('maps only the set fields', () => {
    expect(buildAcceptance({ ...empty, sloP95: '500', sloWrs: '80' })).toEqual({
      maxP95Ms: 500,
      minWrs: 80,
    });
  });
});

describe('buildAssertion', () => {
  it('trims body and coerces status; undefined when empty', () => {
    expect(buildAssertion({ assertStatus: '', assertBody: '  ' })).toBeUndefined();
    expect(buildAssertion({ assertStatus: '200', assertBody: ' ok ' })).toEqual({
      status: 200,
      bodyContains: 'ok',
    });
  });
});

describe('parseFlow', () => {
  it('parses "METHOD /path [thinkMs]" against the target origin', () => {
    const steps = parseFlow('GET /a\nPOST /b 500', 'https://h.wedos')!;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ method: 'GET', url: 'https://h.wedos/a' });
    expect(steps[1]).toMatchObject({ method: 'POST', url: 'https://h.wedos/b', thinkMs: 500 });
  });
  it('returns undefined when empty', () => {
    expect(parseFlow('   ', 'https://h.wedos')).toBeUndefined();
  });
});

describe('parseFlowJson', () => {
  it('parses a JSON array and throws on a non-array', () => {
    expect(parseFlowJson('')).toBeUndefined();
    expect(parseFlowJson('[{"method":"GET","url":"http://h/a"}]')).toHaveLength(1);
    expect(() => parseFlowJson('{"not":"array"}')).toThrow();
  });
});

describe('parseEndpoints', () => {
  it('parses "[METHOD] url [weight]" lines', () => {
    const eps = parseEndpoints('http://h/a 3\nPOST http://h/b 1')!;
    expect(eps[0]).toEqual({ method: undefined, url: 'http://h/a', weight: 3 });
    expect(eps[1]).toEqual({ method: 'POST', url: 'http://h/b', weight: 1 });
  });
});

describe('parseDataset', () => {
  it('parses a CSV header + rows into objects', () => {
    const rows = parseDataset('q,id\napple,1\nbanana,2')!;
    expect(rows).toEqual([
      { q: 'apple', id: '1' },
      { q: 'banana', id: '2' },
    ]);
  });
  it('returns undefined with fewer than 2 lines', () => {
    expect(parseDataset('q,id')).toBeUndefined();
  });
});
