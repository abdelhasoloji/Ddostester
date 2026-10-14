import { describe, it, expect } from 'vitest';
import { buildJmxPlan, combineJMeterMeasurements, parseJtl } from '../src/agents/jmeter.js';
import {
  buildGatlingSim,
  parseGatlingLog,
  combineGatlingMeasurements,
} from '../src/agents/gatling.js';
import { selectAgent, AGENTS } from '../src/agents/index.js';
import type { LoadTestConfig } from '../src/engine/types.js';

const cfg: LoadTestConfig = {
  url: 'http://127.0.0.1:8080/health',
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

describe('jmeter', () => {
  it('reads quoted CSV measurements and rejects invalid latency rows', () => {
    const header = 'elapsed,label,responseCode,responseMessage,success\r\n';
    const result = parseJtl(header + '12,"step, one",200,"OK, done",true\r\n', meta);
    expect(result.statusCounts).toEqual({ '2xx': 1 });
    expect(result.latencyMs.p95).toBe(12);
    expect(() => parseJtl(header + ',step,200,OK,true', meta)).toThrow('Malformed');
    expect(() => parseJtl(header + '-1,step,200,OK,true', meta)).toThrow('Malformed');
    expect(() => parseJtl(header + '12,"unfinished', meta)).toThrow('Truncated');
  });
  it('merges and escapes per-step headers without leaking overrides to other steps', () => {
    const plan = buildJmxPlan({
      ...cfg,
      headers: { 'X-Mode': 'global', 'X-Keep': 'a&b' },
      flow: [
        { url: cfg.url, method: 'GET', headers: { 'X-Mode': 'step' } },
        { url: cfg.url, method: 'POST', body: '{}' },
      ],
    });
    expect(plan).toContain('Header.value">step</stringProp>');
    expect(plan).toContain('Header.value">global</stringProp>');
    expect(plan.match(/Header.value">a&amp;b/g)).toHaveLength(2);
  });
  it('preserves observed starts when shutdown has not flushed any final JTL rows', () => {
    const result = combineJMeterMeasurements('', 2, meta, 4000);
    expect(result.totalRequests).toBe(2);
    expect(result.finalizedRequests).toBe(0);
    expect(result.unfinalizedRequests).toBe(2);
    expect(result.successful).toBe(0);
    expect(result.statusCounts).toEqual({});
    expect(result.latencySampleCount).toBe(0);
    expect(result.actualRps).toBe(0.5);
    expect(() => combineJMeterMeasurements('', NaN, meta, 4000)).toThrow();
    expect(() => combineJMeterMeasurements('', 0, meta, 4000)).toThrow();
  });
  it('generates a bounded JMX with shared request pacing', () => {
    const x = buildJmxPlan(cfg);
    expect(x).toContain('<jmeterTestPlan');
    expect(x).toContain('shared-request-pacing');
    expect(x).toContain('20000000L'); // 1/50 second per shared request slot
    expect(x).toContain('<stringProp name="HTTPSampler.domain">127.0.0.1</stringProp>');
    expect(x).toContain('X-WEDOS-TEST');
  });
  it('parses a JTL and computes percentiles', () => {
    const csv = [
      'timeStamp,elapsed,label,responseCode,responseMessage,success',
      '1,10,req,200,OK,true',
      '2,20,req,200,OK,true',
      '3,30,req,500,KO,false',
      '4,40,req,200,OK,true',
    ].join('\n');
    const r = parseJtl(csv, meta);
    expect(r.totalRequests).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.statusCounts['2xx']).toBe(3);
    expect(r.statusCounts['5xx']).toBe(1);
    expect(r.latencyMs.max).toBe(40);
  });
});

describe('gatling', () => {
  it('retains independently observed statuses when the native latency log was not flushed', () => {
    const result = combineGatlingMeasurements('', '1\t1700000000000\t200000000\ttrue\t2xx=1', meta);
    expect(result.statusCounts).toEqual({ '2xx': 1 });
    expect(result.finalizedRequests).toBe(0);
    expect(result.unfinalizedRequests).toBe(1);
    expect(result.successful).toBe(0);
    expect(() =>
      combineGatlingMeasurements('', '1\t1700000000000\t200000000\ttrue\t2xx=2', meta),
    ).toThrow('status counters');
  });
  it('retains interrupted attempts without inventing finalized outcomes or latencies', () => {
    const result = combineGatlingMeasurements('', '1\t1700000000000\t200000000\ttrue', meta);
    expect(result.totalRequests).toBe(1);
    expect(result.finalizedRequests).toBe(0);
    expect(result.unfinalizedRequests).toBe(1);
    expect(result.latencySampleCount).toBe(0);
    expect(result.statusCounts).toEqual({});
    expect(result.actualRps).toBe(5);
    expect(() => combineGatlingMeasurements('', '', meta)).toThrow('attempt evidence');
    expect(() =>
      combineGatlingMeasurements('', '1\t1700000000000\t200000000\tfalse', meta),
    ).toThrow('attempt evidence');
  });
  it('preserves HTTP timeout, success policy, body and per-step header overrides', () => {
    const direct = buildGatlingSim({ ...cfg, method: 'PUT', body: '{}', timeoutMs: 300 });
    expect(direct).toContain('.body(StringBody("{}"))');
    expect(direct).toContain('requestTimeout(Duration.ofMillis(300))');
    expect(direct).toContain('status().gte(200), status().lt(300)');
    const flow = buildGatlingSim({
      ...cfg,
      headers: { 'X-Mode': 'global' },
      flow: [{ url: cfg.url, method: 'GET', headers: { 'X-Mode': 'step' } }],
    });
    expect(flow).toContain('.header("X-Mode", "step")');
    expect(flow).not.toContain('.header("X-Mode", "global")');
  });
  it('rejects missing or malformed measurements instead of fabricating a zero report', () => {
    expect(() => parseGatlingLog('', meta)).toThrow('no finalized request');
    expect(() => parseGatlingLog('RUN\t...', meta)).toThrow('no finalized request');
    expect(() => parseGatlingLog('REQUEST\treq\tOK', meta)).toThrow('Malformed');
  });
  it('generates a bounded Java simulation (closed concurrency and request throttle)', () => {
    const s = buildGatlingSim(cfg);
    expect(s).toContain('class ShieldTestSimulation extends Simulation');
    expect(s).toContain(`constantConcurrentUsers(${cfg.concurrency}).during(10)`);
    expect(s).toContain('Math.ceil(1_000_000_000d / 50)');
    expect(s).toContain('synchronized Session acquirePermit');
    expect(s).toContain('maxDuration(Duration.ofMillis(10000))');
    expect(s).toContain('disableFollowRedirect()');
    expect(s).toContain('baseUrl("http://127.0.0.1:8080")');
    expect(s).toContain('.get("/health")');
  });
  it('parses simulation.log (best-effort)', () => {
    const log = [
      'RUN\t...',
      'REQUEST\treq\t1700000000000\t1700000000012\tOK\t',
      'REQUEST\treq\t1700000000100\t1700000000140\tKO\tfailed',
      'USER\t...',
    ].join('\n');
    const r = parseGatlingLog(log, meta);
    expect(r.totalRequests).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.latencyMs.max).toBe(40);
  });
});

describe('selectAgent (full)', () => {
  it('lists the 6 agents', () => {
    expect(AGENTS).toEqual(['builtin', 'k6', 'vegeta', 'locust', 'jmeter', 'gatling']);
  });
  it('selects jmeter and gatling', () => {
    expect(selectAgent({ AGENT: 'jmeter' } as NodeJS.ProcessEnv).name).toBe('jmeter');
    expect(selectAgent({ AGENT: 'gatling' } as NodeJS.ProcessEnv).name).toBe('gatling');
  });
});
