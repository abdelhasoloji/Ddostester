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
  it('génère un scénario constant borné au débit', () => {
    const s = buildK6Script(cfg);
    expect(s).toContain("executor: 'constant-arrival-rate'");
    expect(s).toContain('rate: 50');
    expect(s).toContain("duration: '10s'");
    expect(s).toContain('http.request("GET", "http://127.0.0.1/health"');
    expect(s).toContain('X-WEDOS-TEST');
  });
  it('génère des phases (ramping) si scénario', () => {
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
  it('utilise http.post avec un corps pour POST', () => {
    const s = buildK6Script({ ...cfg, method: 'POST', body: '{"a":1}' });
    expect(s).toContain('http.post(');
  });
});

describe('parseK6Summary', () => {
  it('mappe les métriques k6 en LoadTestResult', () => {
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
  it('reste robuste sur un résumé vide', () => {
    const r = parseK6Summary({}, { id: 'x', config: cfg, startedAt: 'a', finishedAt: 'b' });
    expect(r.totalRequests).toBe(0);
    expect(r.failed).toBe(0);
  });
});

describe('selectAgent', () => {
  it('builtin par défaut', () => {
    expect(selectAgent({} as NodeJS.ProcessEnv).name).toBe('builtin-http');
  });
  it('k6 si AGENT=k6', () => {
    expect(selectAgent({ AGENT: 'k6' } as NodeJS.ProcessEnv).name).toBe('k6');
  });
  it("l'agent intégré est toujours disponible", async () => {
    expect(await new BuiltinHttpAgent().available()).toBe(true);
  });
});
