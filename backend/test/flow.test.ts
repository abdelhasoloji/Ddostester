import { describe, expect, it } from 'vitest';
import { iterationRate, validateConfig, TargetNotAllowedError } from '../src/engine/loadTest.js';
import { buildK6Script } from '../src/agents/k6.js';
import { buildGatlingSim } from '../src/agents/gatling.js';
import { buildJmxPlan } from '../src/agents/jmeter.js';
import { buildLocustfile } from '../src/agents/locust.js';
import { createCampaign, CampaignError } from '../src/modules/campaigns/service.js';
import type { LoadTestConfig, RequestStep } from '../src/engine/types.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const allowed = ['127.0.0.1', 'localhost'];
const flow: RequestStep[] = [
  { method: 'GET', url: 'http://127.0.0.1/a' },
  { method: 'POST', url: 'http://127.0.0.1/b', body: '{"x":1}', thinkMs: 500 },
  { method: 'GET', url: 'http://127.0.0.1/c' },
];
const cfg = (over: Partial<LoadTestConfig> = {}): LoadTestConfig => ({
  url: 'http://127.0.0.1/',
  headers: { 'X-WEDOS-TEST': 'abc' },
  concurrency: 5,
  durationSec: 10,
  maxRps: 60,
  authorized: true,
  ...over,
});

describe('iterationRate', () => {
  it('divides the rate by the step count (floored, >= 1)', () => {
    expect(iterationRate(60, 3)).toBe(20);
    expect(iterationRate(5, 10)).toBe(1); // floor(0.5) -> 0 -> clamped to 1
    expect(iterationRate(100, 1)).toBe(100);
  });
});

describe('validateConfig flow', () => {
  it('rejects a flow step outside the allowlist', () => {
    expect(() =>
      validateConfig(cfg({ flow: [{ method: 'GET', url: 'http://evil.example/x' }] }), allowed),
    ).toThrow(TargetNotAllowedError);
  });
  it('rejects an out-of-range think-time', () => {
    expect(() =>
      validateConfig(
        cfg({ flow: [{ method: 'GET', url: 'http://127.0.0.1/a', thinkMs: 999999 }] }),
        allowed,
      ),
    ).toThrow();
  });
  it('accepts a valid flow', () => {
    expect(() => validateConfig(cfg({ flow }), allowed)).not.toThrow();
  });
});

describe('k6 flow', () => {
  it('caps the iteration rate and renders each step + think', () => {
    const s = buildK6Script(cfg({ flow }));
    expect(s).toContain('rate: 20');
    expect(s).toContain('http.request("GET", "http://127.0.0.1/a"');
    expect(s).toContain('http.request("POST", "http://127.0.0.1/b"');
    expect(s).toContain('sleep(0.500)');
  });
});

describe('gatling flow', () => {
  it('divides users/sec, chains steps and pauses', () => {
    const s = buildGatlingSim(cfg({ flow }));
    expect(s).toContain('import java.time.Duration;');
    expect(s).toContain('constantUsersPerSec(20).during(10)');
    expect(s).toContain('.get("http://127.0.0.1/a")');
    expect(s).toContain('.post("http://127.0.0.1/b")');
    expect(s).toContain('.pause(Duration.ofMillis(500))');
  });
});

describe('jmeter flow', () => {
  it('renders one sampler per step, a think timer and a shared throughput cap', () => {
    const x = buildJmxPlan(cfg({ flow }));
    expect(x).toContain('testname="step-1"');
    expect(x).toContain('testname="step-3"');
    expect(x).toContain('<stringProp name="ConstantTimer.delay">500</stringProp>');
    expect(x).toContain('<value>3600</value>'); // 60 rps * 60 shared across samplers
  });
});

describe('locust flow', () => {
  it('paces so users*steps/pacing ≈ maxRps and sleeps between steps', () => {
    const f = buildLocustfile(cfg({ flow }));
    expect(f).toContain('import time');
    expect(f).toContain('time.sleep(0.500)');
    // pacing = users(5) * steps(3) / maxRps(60) = 0.25
    expect(f).toContain('constant_pacing(0.25)');
  });
});

describe('createCampaign flow validation', () => {
  const base: CampaignInput = {
    name: 'flow',
    target: 'http://127.0.0.1/',
    vector: 'http-get',
    maxRps: 60,
    concurrency: 5,
    maxDurationSec: 10,
    probeUrl: 'http://127.0.0.1/health',
    createdBy: 'eng@wedos',
    authorized: true,
  };
  const agents = [
    { id: 'builtin', multiPhase: true, flowCapable: true },
    { id: 'vegeta', multiPhase: true, flowCapable: false },
  ];

  it('accepts a flow on a flow-capable engine', () => {
    const c = createCampaign({ ...base, agent: 'builtin', flow }, allowed, agents);
    expect(c.flow).toHaveLength(3);
  });
  it('rejects a flow on a non-flow-capable engine', () => {
    expect(() => createCampaign({ ...base, agent: 'vegeta', flow }, allowed, agents)).toThrow(
      /multi-step flows/,
    );
  });
  it('rejects a flow step outside the allowlist', () => {
    expect(() =>
      createCampaign({ ...base, flow: [{ method: 'GET', url: 'http://evil.example/' }] }, allowed),
    ).toThrow(CampaignError);
  });
});
