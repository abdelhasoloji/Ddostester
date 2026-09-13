import { describe, it, expect } from 'vitest';
import {
  buildVegetaTarget,
  parseVegetaReport,
  mergeResults,
  VegetaLiveMeter,
} from '../src/agents/vegeta.js';
import { buildLocustfile, parseLocustStats } from '../src/agents/locust.js';
import { selectAgent, AGENTS } from '../src/agents/index.js';
import type { LoadTestConfig } from '../src/engine/types.js';

const cfg: LoadTestConfig = {
  url: 'http://127.0.0.1/health',
  method: 'GET',
  headers: { 'X-WEDOS-TEST': 'abc' },
  concurrency: 5,
  durationSec: 10,
  maxRps: 50,
  authorized: true,
};
const meta = {
  id: 'x',
  config: cfg,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:10Z',
};

describe('vegeta', () => {
  it('builds the target with method, url and headers', () => {
    const t = buildVegetaTarget(cfg);
    expect(t).toContain('GET http://127.0.0.1/health');
    expect(t).toContain('X-WEDOS-TEST: abc');
  });
  it('bounds attack memory (-max-body 0, -timeout) and sizes workers to the RATE', async () => {
    const { vegetaAttackArgs } = await import('../src/agents/vegeta.js');
    const args = vegetaAttackArgs(
      { ...cfg, concurrency: 80, timeoutMs: 8000 },
      400,
      120,
      '/t/f.txt',
    );
    expect(args).toContain('-max-body');
    expect(args[args.indexOf('-max-body') + 1]).toBe('0');
    // Workers must sustain the rate against a slow target (≈ rate × timeout),
    // NOT the campaign concurrency — capping at concurrency (80) throttled
    // vegeta to ~10 rps on slow endpoints. 400 rps × 8 s = 3200.
    expect(args[args.indexOf('-max-workers') + 1]).toBe('3200');
    expect(args[args.indexOf('-timeout') + 1]).toBe('8s');
    expect(args).toContain('-rate');
    expect(args[args.indexOf('-rate') + 1]).toBe('400/1s');
  });

  it('never sizes workers below the operator concurrency, and caps the ceiling', async () => {
    const { vegetaAttackArgs } = await import('../src/agents/vegeta.js');
    // Low rate × short timeout would give few workers → floor at concurrency.
    const low = vegetaAttackArgs({ ...cfg, concurrency: 200, timeoutMs: 1000 }, 50, 60, '/t/f.txt');
    expect(low[low.indexOf('-max-workers') + 1]).toBe('200');
    // Pathological rate × long timeout is capped so workers can't grow unbounded.
    const high = vegetaAttackArgs(
      { ...cfg, concurrency: 10, timeoutMs: 60_000 },
      2000,
      60,
      '/t/f.txt',
    );
    expect(high[high.indexOf('-max-workers') + 1]).toBe('20000');
  });

  it('emits one target block per endpoint (recon-seeded surface)', () => {
    const t = buildVegetaTarget({
      ...cfg,
      method: 'POST',
      endpoints: [{ url: 'http://127.0.0.1/login' }, { url: 'http://127.0.0.1/api/reset' }],
    });
    // Two blocks separated by a blank line, each carrying the campaign method.
    const blocks = t.trim().split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(t).toContain('POST http://127.0.0.1/login');
    expect(t).toContain('POST http://127.0.0.1/api/reset');
    expect(t).not.toContain('http://127.0.0.1/health'); // root is not used when endpoints are set
  });
  it('expands into a pool of unique cache-busted URLs when cacheBust is set', () => {
    const t = buildVegetaTarget({ ...cfg, cacheBust: true });
    const blocks = t.trim().split('\n\n');
    // A pool of variants (not a single static line), each a unique _cb URL.
    expect(blocks.length).toBeGreaterThan(100);
    const urls = blocks.map((b) => b.split('\n')[0]);
    expect(urls.every((u) => /[?&]_cb=/.test(u))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length); // all distinct
  });
  it('does not cache-bust when the flag is off', () => {
    const t = buildVegetaTarget(cfg);
    expect(t).not.toContain('_cb=');
  });
  it('splitRate spreads a phase rate across workers so they sum exactly (P4)', async () => {
    const { splitRate } = await import('../src/agents/vegeta.js');
    expect(splitRate(800, 1)).toEqual([800]);
    expect(splitRate(800, 3)).toEqual([267, 267, 266]);
    expect(splitRate(800, 3).reduce((a, b) => a + b, 0)).toBe(800);
    expect(splitRate(5, 8)).toEqual([1, 1, 1, 1, 1]); // zero-rate workers dropped
    expect(splitRate(1000, 20).length).toBe(8); // capped at MAX_VEGETA_PARALLELISM
  });

  it('passes -keepalive=false when keep-alive is disabled, true otherwise', async () => {
    const { vegetaAttackArgs } = await import('../src/agents/vegeta.js');
    const off = vegetaAttackArgs({ ...cfg, noKeepAlive: true }, 100, 30, '/t/f.txt');
    expect(off).toContain('-keepalive=false');
    const on = vegetaAttackArgs(cfg, 100, 30, '/t/f.txt');
    expect(on).toContain('-keepalive=true');
  });
  it('parse un rapport JSON (latences ns → ms)', () => {
    const rep = {
      requests: 500,
      rate: 49.9,
      success: 0.98,
      latencies: { min: 1e6, mean: 6e6, '50th': 5e6, '95th': 12e6, '99th': 20e6, max: 40e6 },
      status_codes: { '200': 490, '500': 10 },
    };
    const r = parseVegetaReport(rep, meta);
    expect(r.totalRequests).toBe(500);
    expect(r.failed).toBe(10);
    expect(r.latencyMs.p95).toBe(12);
    expect(r.statusCounts['2xx']).toBe(490);
    expect(r.statusCounts['5xx']).toBe(10);
  });
  it('live meter turns streamed results into a LoadProgress snapshot', () => {
    const m = new VegetaLiveMeter();
    // 3 ok (2xx), 1 edge-rejected (4xx), 1 transport error (code 0) → 2 failed.
    m.add({ code: 200, latency: 5e6 }); // 5ms
    m.add({ code: 204, latency: 10e6 }); // 10ms
    m.add({ code: 302, latency: 15e6 }); // 15ms (3xx counts successful)
    m.add({ code: 429, latency: 20e6 }); // 20ms, failed
    m.add({ code: 0, latency: 30e6, error: 'dial tcp: timeout' }); // failed
    const p = m.snapshot(5); // 5 requests over 5s
    expect(p.sent).toBe(5);
    expect(p.failed).toBe(2);
    expect(p.successful).toBe(3);
    expect(p.actualRps).toBe(1);
    expect(p.statusCounts).toMatchObject({ '2xx': 2, '3xx': 1, '4xx': 1, err: 1 });
    // Latency percentiles are reported in ms (ns / 1e6).
    expect(p.latencyMs?.p50).toBeGreaterThanOrEqual(10);
    expect(p.latencyMs?.p99).toBe(30);
  });
  it('live meter is empty-safe before any result', () => {
    const p = new VegetaLiveMeter().snapshot(0);
    expect(p.sent).toBe(0);
    expect(p.actualRps).toBe(0);
    expect(p.latencyMs?.p95).toBe(0);
  });

  it('merges sequential phases', () => {
    const a = parseVegetaReport(
      {
        requests: 100,
        rate: 10,
        success: 1,
        latencies: { mean: 5e6, '50th': 5e6, '95th': 8e6, '99th': 9e6, min: 1e6, max: 10e6 },
      },
      meta,
    );
    const b = parseVegetaReport(
      {
        requests: 300,
        rate: 30,
        success: 0.9,
        latencies: { mean: 6e6, '50th': 6e6, '95th': 12e6, '99th': 15e6, min: 1e6, max: 20e6 },
      },
      meta,
    );
    const m = mergeResults([a, b], meta);
    expect(m.totalRequests).toBe(400);
    expect(m.failed).toBe(30);
  });
});

describe('locust', () => {
  it('generates a bounded locustfile (constant_pacing)', () => {
    const f = buildLocustfile(cfg);
    expect(f).toContain('constant_pacing(');
    expect(f).toContain('self.client.request("GET", "/health"');
  });
  it('parse la ligne Aggregated du CSV', () => {
    const csv = [
      'Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,95%,99%,100%',
      'GET,/health,480,20,5,6,1,40,120,49.5,2,5,12,20,40',
      ',Aggregated,500,20,5,6,1,40,120,49.5,2,5,12,20,40',
    ].join('\n');
    const r = parseLocustStats(csv, meta);
    expect(r.totalRequests).toBe(500);
    expect(r.failed).toBe(20);
    expect(r.latencyMs.p95).toBe(12);
    expect(r.actualRps).toBe(49.5);
  });
});

describe('selectAgent', () => {
  it('expose la liste des agents', () => {
    expect(AGENTS).toEqual(['builtin', 'k6', 'vegeta', 'locust', 'jmeter', 'gatling']);
  });
  it('selects each agent', () => {
    expect(selectAgent({ AGENT: 'vegeta' } as NodeJS.ProcessEnv).name).toBe('vegeta');
    expect(selectAgent({ AGENT: 'locust' } as NodeJS.ProcessEnv).name).toBe('locust');
    expect(selectAgent({ AGENT: 'k6' } as NodeJS.ProcessEnv).name).toBe('k6');
    expect(selectAgent({} as NodeJS.ProcessEnv).name).toBe('builtin-http');
  });
});
