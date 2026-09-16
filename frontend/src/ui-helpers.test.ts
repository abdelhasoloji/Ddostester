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
  protectionBadgeState,
  protectionBadgeTitle,
  wrsClass,
} from './ui.js';

describe('wrsClass', () => {
  it('maps levels to CSS classes (A+ → wrs-Ap)', () => {
    expect(wrsClass('A+')).toBe('wrs-Ap');
    expect(wrsClass('B')).toBe('wrs-B');
  });
});

describe('protectionBadgeTitle (E12 — vector-aware)', () => {
  const eng = { sent: 100, failed: 40, statusCounts: {}, probe: { samples: 10, available: 10 } };
  it('frames a flood as request absorption', () => {
    const t = protectionBadgeTitle(false, 40, eng as never, 'http-get');
    expect(t).toMatch(/absorbing 40% of the offered load/);
    expect(t).toMatch(/requests never reached/);
    expect(t).not.toMatch(/connections/);
  });
  it('frames slowloris as connections shed, not requests', () => {
    const t = protectionBadgeTitle(false, 40, eng as never, 'http-slowloris');
    expect(t).toMatch(/shedding slow connections/);
    expect(t).toMatch(/40 of 100 opened connections dropped/);
    expect(t).toMatch(/correct defense against a slow-header attack/);
    expect(t).not.toMatch(/requests never reached/);
  });
  it('slowloris low-shed message talks about held connections', () => {
    const t = protectionBadgeTitle(false, 5, { ...eng, failed: 5 } as never, 'http-slowloris');
    expect(t).toMatch(/holding 95 of 100 slow connections/);
  });
});

describe('protectionBadgeState (the legit probe decides down vs protected)', () => {
  const up = { samples: 10, available: 10, health: 'ok' as const };
  const down = { samples: 10, available: 0, health: 'critical' as const };

  it('high absorbed% with the probe UP = protection engaging', () => {
    expect(protectionBadgeState(false, 100, { sent: 100, failed: 100, probe: up } as never)).toBe(
      'protecting',
    );
  });

  it('high absorbed% with the probe DOWN = target overwhelmed (NOT protection)', () => {
    // The exact bug: a bare origin 5xx-ing every request shows ~100% "absorbed"
    // but the legit probe is 0% up — it is being taken down, not defended.
    expect(protectionBadgeState(false, 100, { sent: 100, failed: 100, probe: down } as never)).toBe(
      'overwhelmed',
    );
  });

  it('a probe below 50% up is overwhelmed even without a critical health flag', () => {
    const half = { samples: 10, available: 4, health: 'degraded' as const };
    expect(protectionBadgeState(false, 80, { sent: 100, failed: 80, probe: half } as never)).toBe(
      'overwhelmed',
    );
  });

  it('waiting → baseline; low absorbed + probe up → running', () => {
    expect(protectionBadgeState(true, 0, null)).toBe('baseline');
    expect(protectionBadgeState(false, 5, { sent: 100, failed: 5, probe: up } as never)).toBe(
      'running',
    );
  });

  it('no probe samples yet is not prematurely called overwhelmed', () => {
    expect(
      protectionBadgeState(false, 100, {
        sent: 100,
        failed: 100,
        probe: { samples: 0, available: 0 },
      } as never),
    ).toBe('protecting');
  });
});

describe('protectionBadgeTitle — target overwhelmed', () => {
  it('tells the honest story when the legit probe is down (no "protection working")', () => {
    const t = protectionBadgeTitle(
      false,
      100,
      {
        sent: 100,
        failed: 100,
        statusCounts: { '5xx': 100 },
        probe: { samples: 10, available: 0, health: 'critical' },
      } as never,
      'http-get',
    );
    expect(t).toMatch(/Target overwhelmed/);
    expect(t).toMatch(/origin failing under load/);
    expect(t).not.toMatch(/protection working/);
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
  it('keeps a path containing spaces instead of dropping the tail', () => {
    const [step] = parseFlow('GET /my page', 'https://h.wedos')!;
    // The space is preserved (URL-encoded) rather than being mistaken for think-time.
    expect(step.url).toBe('https://h.wedos/my%20page');
    expect(step.thinkMs).toBeUndefined();
  });
  it('still reads a trailing numeric think-time after a multi-word path', () => {
    const [step] = parseFlow('POST /my page 250', 'https://h.wedos')!;
    expect(step.url).toBe('https://h.wedos/my%20page');
    expect(step.thinkMs).toBe(250);
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
