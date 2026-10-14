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
  it('does not round a whole flow above the request budget', () => {
    expect(iterationRate(60, 3)).toBe(20);
    expect(iterationRate(5, 10)).toBe(0);
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
  it('bounds request timeouts and preserves step headers for plain and correlated flows', () => {
    const plain = buildK6Script(
      cfg({
        timeoutMs: 1000,
        flow: [
          {
            method: 'POST',
            url: 'http://127.0.0.1/a',
            headers: { 'content-type': 'application/json' },
          },
        ],
      }),
    );
    expect(plain).toContain("timeout: '1000ms'");
    expect(plain).toContain('"content-type": "application/json"');
    expect(plain).toContain('http.expectedStatuses({ min: 200, max: 299 })');
    const correlated = buildK6Script(
      cfg({
        timeoutMs: 1200,
        flow: [
          {
            method: 'GET',
            url: 'http://127.0.0.1/a',
            extract: { name: 'id', from: 'json', expr: 'id' },
          },
        ],
      }),
    );
    expect(correlated).toContain("timeout: '1200ms'");
    expect(() => buildK6Script(cfg({ timeoutMs: Infinity }))).toThrow();
  });

  it('rejects non-finite phase rates and unrepresentable scheduling periods', () => {
    expect(() => buildK6Script(cfg({ phases: [{ maxRps: Infinity, durationSec: 3 }] }))).toThrow();
    expect(() => buildK6Script(cfg({ maxRps: Number.MIN_VALUE }))).toThrow();
    expect(() => buildK6Script(cfg({ maxRps: Number.MAX_VALUE }))).toThrow();
  });

  it('widens the time unit for low-budget journeys and phases', () => {
    const single = buildK6Script(cfg({ flow, maxRps: 1 }));
    expect(single).toContain("timeUnit: '3s'");
    expect(single).toContain("gracefulStop: '0s'");
    expect(single).toContain('rate: 1');
    const phased = buildK6Script(
      cfg({
        flow,
        maxRps: 5,
        phases: [
          { maxRps: 1, durationSec: 3 },
          { maxRps: 5, durationSec: 3 },
        ],
      }),
    );
    expect(phased).toContain("timeUnit: '3s'");
    expect(phased).toContain("gracefulStop: '0s'");
    expect(phased).toContain('startRate: 1');
    expect(phased).toContain("target: 5, duration: '3s'");
  });

  it('schedules fractional single-request rates without raising them to 1 RPS', () => {
    const script = buildK6Script(cfg({ maxRps: 0.5 }));
    expect(script).toContain("timeUnit: '2s'");
    expect(script).toContain('rate: 1');
  });

  it('caps the iteration rate and renders each step + think', () => {
    const s = buildK6Script(cfg({ flow }));
    expect(s).toContain('rate: 20');
    expect(s).toContain('_request("GET", "http://127.0.0.1/a"');
    expect(s).toContain('_request("POST", "http://127.0.0.1/b"');
    expect(s).toContain('sleep(0.500)');
  });
});

describe('gatling flow', () => {
  it('caps concurrent users and total request rate, chains steps and pauses', () => {
    const s = buildGatlingSim(cfg({ flow }));
    expect(s).toContain('import java.time.Duration;');
    expect(s).toContain('constantConcurrentUsers(5).during(10)');
    expect(s).toContain('Math.ceil(1_000_000_000d / 60)');
    expect(s).toContain('.get("http://127.0.0.1/a")');
    expect(s).toContain('.post("http://127.0.0.1/b")');
    expect(s).toContain('.pause(Duration.ofMillis(500))');
  });
});

describe('jmeter flow', () => {
  it('renders one HTTP sampler per step and pauses after requests', () => {
    const x = buildJmxPlan(cfg({ flow }));
    expect(x).toContain('testname="step-1"');
    expect(x).toContain('testname="step-3"');
    expect(x).toContain('<stringProp name="ActionProcessor.duration">500</stringProp>');
    expect(x).toContain('16666667L'); // Shared slots cap all HTTP samplers at 60 rps
  });
});

describe('locust flow', () => {
  it('shares the request cap across all users/steps and keeps think pauses', () => {
    const f = buildLocustfile(cfg({ flow }));
    expect(f).toContain('time.monotonic()');
    expect(f).toContain('time.sleep(0.5)');
    expect(f).toContain(`_interval = ${1 / 60}`);
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
    {
      id: 'builtin',
      multiPhase: true,
      flowCapable: true,
      endpointCapable: true,
      correlationCapable: true,
    },
    {
      id: 'k6',
      multiPhase: true,
      flowCapable: true,
      endpointCapable: true,
      correlationCapable: false,
    },
    {
      id: 'vegeta',
      multiPhase: true,
      flowCapable: false,
      endpointCapable: true,
      correlationCapable: false,
    },
  ];
  const corrFlow = [
    {
      method: 'POST' as const,
      url: 'http://127.0.0.1/login',
      extract: { name: 'token', from: 'json' as const, expr: 'token' },
    },
    {
      method: 'GET' as const,
      url: 'http://127.0.0.1/me',
      headers: { Authorization: 'Bearer {{token}}' },
    },
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

  it('accepts correlation on the built-in engine', () => {
    const c = createCampaign({ ...base, agent: 'builtin', flow: corrFlow }, allowed, agents);
    expect(c.flow?.[0].extract?.name).toBe('token');
  });

  it('rejects correlation on a flow-capable but non-correlation engine (k6)', () => {
    expect(() => createCampaign({ ...base, agent: 'k6', flow: corrFlow }, allowed, agents)).toThrow(
      /correlation/,
    );
  });

  it('rejects an invalid extract rule', () => {
    expect(() =>
      createCampaign(
        {
          ...base,
          agent: 'builtin',
          flow: [
            {
              method: 'GET',
              url: 'http://127.0.0.1/a',
              extract: { name: '', from: 'json', expr: 'x' },
            },
          ],
        },
        allowed,
        agents,
      ),
    ).toThrow(CampaignError);
  });
});
