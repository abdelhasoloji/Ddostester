import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import {
  queryRange,
  rangeWindow,
  type FetchLike,
} from '../src/modules/metrics/prometheus-query.js';
import { resolveSeries, sanitizeTarget } from '../src/modules/metrics/series-catalog.js';

describe('series-catalog', () => {
  it('resolves a per-run series with a sanitised target', () => {
    const r = resolveSeries('run_rps', 'bank.cz');
    expect(r).not.toBeNull();
    expect(r!.def.unit).toBe('reqps');
    expect(r!.lines.map((l) => l.label)).toEqual(['offered', 'successful responses']);
    expect(r!.lines[0].promql).toContain('shieldtest_run_live_offered_rps{target="bank.cz"}');
  });

  it('refuses an unknown series and a per-run series with no target', () => {
    expect(resolveSeries('nope', 'bank.cz')).toBeNull();
    for (const key of ['toString', 'constructor', '__proto__'])
      expect(resolveSeries(key, 'bank.cz')).toBeNull();
    expect(resolveSeries('run_rps')).toBeNull(); // needs a target
  });

  it('allows a global series without a target', () => {
    expect(resolveSeries('eventloop_lag')).not.toBeNull();
  });

  it('resolves the run_availability panel to the live probe-availability gauge', () => {
    const r = resolveSeries('run_availability', 'bank.cz');
    expect(r).not.toBeNull();
    expect(r!.def.unit).toBe('percent');
    expect(r!.lines[0].promql).toContain('shieldtest_run_live_probe_avail_pct{target="bank.cz"}');
    expect(resolveSeries('run_availability')).toBeNull(); // needs a target
  });

  it('strips PromQL-breaking characters from the target', () => {
    expect(sanitizeTarget('bank.cz"} or up{')).toBe('bank.czorup');
  });
});

describe('queryRange', () => {
  it('rejects non-finite monitoring observations instead of serializing them as null', async () => {
    for (const value of ['NaN', '+Inf', '-Inf']) {
      const fetchImpl: FetchLike = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: { result: [{ values: [[0, value]] }] } }),
      });
      const result = await queryRange(
        'http://prom',
        'up',
        { startS: 0, endS: 60, stepS: 15 },
        { fetchImpl },
      );
      expect(result.status).toBe('error');
      expect(result.series).toEqual([]);
    }
  });
  const range = { startS: 0, endS: 60, stepS: 15 };

  it('reports unavailable with no base URL', async () => {
    const r = await queryRange(undefined, 'up', range);
    expect(r.status).toBe('unavailable');
    expect(r.series).toEqual([]);
  });

  it('parses a successful Prometheus range response through an injected fetch', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          result: [
            {
              metric: { target: 'bank.cz' },
              values: [
                [0, '10'],
                [15, '12.5'],
              ],
            },
          ],
        },
      }),
    });
    const r = await queryRange('http://prom', 'q', range, { fetchImpl });
    expect(r.status).toBe('ok');
    expect(r.series[0].labels.target).toBe('bank.cz');
    expect(r.series[0].points).toEqual([
      [0, 10],
      [15, 12.5],
    ]);
  });

  it('maps an HTTP failure and a thrown fetch to error (never throws)', async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 502, json: async () => ({}) });
    expect((await queryRange('http://prom', 'q', range, { fetchImpl: bad })).status).toBe('error');
    const boom: FetchLike = async () => {
      throw new Error('down');
    };
    const r = await queryRange('http://prom', 'q', range, { fetchImpl: boom });
    expect(r.status).toBe('error');
    expect(r.error).toBe('down');
  });
});

describe('rangeWindow (query window scoping)', () => {
  const NOW = 1_000_000 * 1000; // a round unix-ms so endS = 1_000_000

  it('defaults to a 15-minute lookback', () => {
    const w = rangeWindow(NOW, {});
    expect(w.endS).toBe(1_000_000);
    expect(w.endS - w.startS).toBe(15 * 60);
    expect(w.stepS).toBe(15);
  });

  it('honours a `minutes` lookback, clamped to [1, 1440]', () => {
    expect(rangeWindow(NOW, { minutes: 5 }).endS - rangeWindow(NOW, { minutes: 5 }).startS).toBe(
      5 * 60,
    );
    expect(rangeWindow(NOW, { minutes: 99999 }).startS).toBe(1_000_000 - 1440 * 60); // clamped
  });

  it('sinceSec scopes the window to that span and WINS over minutes (the Run-Theater fix)', () => {
    // A 98s-elapsed run must query a ~98s window, not a 15-min one that would pick
    // up an earlier run against the same target.
    const w = rangeWindow(NOW, { minutes: 15, sinceSec: 98 });
    expect(w.endS - w.startS).toBe(98);
  });

  it('clamps sinceSec to [5s, 24h] and ignores non-positive/NaN values', () => {
    expect(rangeWindow(NOW, { sinceSec: 1 }).endS - rangeWindow(NOW, { sinceSec: 1 }).startS).toBe(
      5,
    );
    expect(
      rangeWindow(NOW, { sinceSec: 999999 }).endS - rangeWindow(NOW, { sinceSec: 999999 }).startS,
    ).toBe(86400);
    // 0 / NaN → fall back to the minutes lookback (default 15m).
    expect(rangeWindow(NOW, { sinceSec: 0 }).endS - rangeWindow(NOW, { sinceSec: 0 }).startS).toBe(
      15 * 60,
    );
    expect(
      rangeWindow(NOW, { sinceSec: 'x' }).endS - rangeWindow(NOW, { sinceSec: 'x' }).startS,
    ).toBe(15 * 60);
  });
});

describe('GET /api/metrics/range', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
      allowedTargets: ['bank.cz'],
      logger: false,
      serveStatic: false,
      // prometheusUrl intentionally unset → graceful 'unavailable'
    });
    app = built.app;
  });

  it('rejects inherited property names through the HTTP boundary', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/metrics/range?series=constructor',
    });
    expect(response.statusCode).toBe(400);
  });

  it('400s an unknown series', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/metrics/range?series=nope' });
    expect(r.statusCode).toBe(400);
  });

  it('returns unavailable (not an error) when Prometheus is not configured', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/metrics/range?series=run_rps&target=bank.cz',
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.source).toBe('unavailable');
    expect(b.unit).toBe('reqps');
    expect(b.series.map((s: { label: string }) => s.label)).toEqual([
      'offered',
      'successful responses',
    ]);
  });
});
