import { describe, it, expect } from 'vitest';
import { buildJmxPlan, parseJtl } from '../src/agents/jmeter.js';
import { buildGatlingSim, parseGatlingLog } from '../src/agents/gatling.js';
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
  it('generates a bounded JMX (Constant Throughput Timer = rps*60)', () => {
    const x = buildJmxPlan(cfg);
    expect(x).toContain('<jmeterTestPlan');
    expect(x).toContain('ConstantThroughputTimer');
    expect(x).toContain('<value>3000</value>'); // 50 rps * 60
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
  it('generates a bounded Java simulation (constantUsersPerSec)', () => {
    const s = buildGatlingSim(cfg);
    expect(s).toContain('class ShieldTestSimulation extends Simulation');
    expect(s).toContain('constantUsersPerSec(50).during(10)');
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
