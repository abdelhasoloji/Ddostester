import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { queryRange, type FetchLike } from '../src/modules/metrics/prometheus-query.js';
import { resolveSeries, sanitizeTarget } from '../src/modules/metrics/series-catalog.js';

describe('series-catalog', () => {
  it('resolves a per-run series with a sanitised target', () => {
    const r = resolveSeries('run_rps', 'bank.cz');
    expect(r).not.toBeNull();
    expect(r!.def.unit).toBe('reqps');
    expect(r!.lines.map((l) => l.label)).toEqual(['offered', 'reached origin']);
    expect(r!.lines[0].promql).toContain('shieldtest_run_live_offered_rps{target="bank.cz"}');
  });

  it('refuses an unknown series and a per-run series with no target', () => {
    expect(resolveSeries('nope', 'bank.cz')).toBeNull();
    expect(resolveSeries('run_rps')).toBeNull(); // needs a target
  });

  it('allows a global series without a target', () => {
    expect(resolveSeries('eventloop_lag')).not.toBeNull();
  });

  it('strips PromQL-breaking characters from the target', () => {
    expect(sanitizeTarget('bank.cz"} or up{')).toBe('bank.czorup');
  });
});

describe('queryRange', () => {
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

describe('GET /api/metrics/range', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: ['bank.cz'],
      logger: false,
      serveStatic: false,
      // prometheusUrl intentionally unset → graceful 'unavailable'
    });
    app = built.app;
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
    expect(b.series.map((s: { label: string }) => s.label)).toEqual(['offered', 'reached origin']);
  });
});
