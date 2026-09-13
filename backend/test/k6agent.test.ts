import { describe, it, expect } from 'vitest';
import { buildK6Script, parseK6Summary } from '../src/agents/k6.js';
import { BuiltinHttpAgent } from '../src/agents/builtin.js';
import { selectAgent } from '../src/agents/index.js';
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

describe('buildK6Script', () => {
  it('generates a constant scenario capped at the rate', () => {
    const s = buildK6Script(cfg);
    expect(s).toContain("executor: 'constant-arrival-rate'");
    expect(s).toContain('rate: 50');
    expect(s).toContain("duration: '10s'");
    expect(s).toContain('http.request("GET", "http://127.0.0.1/health"');
    expect(s).toContain('X-WEDOS-TEST');
  });
  it('spreads over a recon-seeded endpoint set (random pick per iteration)', () => {
    const s = buildK6Script({
      ...cfg,
      method: 'POST',
      body: '{"a":1}',
      endpoints: [{ url: 'http://127.0.0.1/login' }, { url: 'http://127.0.0.1/api/reset' }],
    });
    expect(s).toContain('http://127.0.0.1/login');
    expect(s).toContain('http://127.0.0.1/api/reset');
    expect(s).toContain('Math.random()');
    expect(s).toContain('http.request("POST"');
    expect(s).not.toContain('"http://127.0.0.1/health"'); // root not used with endpoints
  });
  it('generates ramping phases when a scenario is given', () => {
    const s = buildK6Script({
      ...cfg,
      phases: [
        { maxRps: 10, durationSec: 5 },
        { maxRps: 40, durationSec: 5 },
      ],
    });
    expect(s).toContain("executor: 'ramping-arrival-rate'");
    expect(s).toContain("{ target: 10, duration: '5s' }");
    expect(s).toContain("{ target: 40, duration: '5s' }");
  });
  it('sends a body for POST', () => {
    const s = buildK6Script({ ...cfg, method: 'POST', body: '{"a":1}' });
    expect(s).toContain('http.request("POST", "http://127.0.0.1/health"');
    expect(s).toContain('{\\"a\\":1}');
  });

  it('wraps the URL in the _cb() cache-buster when cacheBust is set', () => {
    const s = buildK6Script({ ...cfg, cacheBust: true });
    expect(s).toContain('const _cb ='); // helper injected
    expect(s).toContain('http.request("GET", _cb("http://127.0.0.1/health")');
  });
  it('has no cache-buster when the flag is off', () => {
    const s = buildK6Script(cfg);
    expect(s).not.toContain('_cb');
  });

  it('renders a multi-step flow and caps the iteration rate at maxRps/steps', () => {
    const s = buildK6Script({
      ...cfg,
      maxRps: 60,
      flow: [
        { method: 'GET', url: 'http://127.0.0.1/a' },
        { method: 'POST', url: 'http://127.0.0.1/b', body: '{}', thinkMs: 500 },
        { method: 'GET', url: 'http://127.0.0.1/c' },
      ],
    });
    // 60 rps / 3 steps = 20 iterations/s → ~60 requests/s total.
    expect(s).toContain('rate: 20');
    expect(s).toContain('http.request("GET", "http://127.0.0.1/a"');
    expect(s).toContain('http.request("POST", "http://127.0.0.1/b"');
    expect(s).toContain('sleep(0.500)');
    expect(s).toContain("import { sleep } from 'k6'");
  });
});

describe('parseK6Summary', () => {
  it('maps k6 metrics into a LoadTestResult', () => {
    const summary = {
      metrics: {
        http_reqs: { count: 500, rate: 49.8 },
        http_req_failed: { value: 0.02 },
        http_req_duration: { min: 1, med: 5, avg: 6, max: 40, 'p(95)': 12, 'p(99)': 20 },
      },
    };
    const r = parseK6Summary(summary, { id: 'x', config: cfg, startedAt: 'a', finishedAt: 'b' });
    expect(r.totalRequests).toBe(500);
    expect(r.failed).toBe(10);
    expect(r.successful).toBe(490);
    expect(r.actualRps).toBe(49.8);
    expect(r.latencyMs.p95).toBe(12);
    expect(r.latencyMs.p99).toBe(20);
  });
  it('stays robust on an empty summary', () => {
    const r = parseK6Summary({}, { id: 'x', config: cfg, startedAt: 'a', finishedAt: 'b' });
    expect(r.totalRequests).toBe(0);
    expect(r.failed).toBe(0);
  });
});

describe('selectAgent', () => {
  it('builtin by default', () => {
    expect(selectAgent({} as NodeJS.ProcessEnv).name).toBe('builtin-http');
  });
  it('k6 when AGENT=k6', () => {
    expect(selectAgent({ AGENT: 'k6' } as NodeJS.ProcessEnv).name).toBe('k6');
  });
  it('the built-in agent is always available', async () => {
    expect(await new BuiltinHttpAgent().available()).toBe(true);
  });
});
