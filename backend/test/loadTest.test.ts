import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildEndpointPicker,
  runLoadTest,
  validateConfig,
  InvalidConfigError,
  TargetNotAllowedError,
} from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';

const base: LoadTestConfig = {
  url: 'http://localhost:3000/health',
  concurrency: 5,
  durationSec: 3,
  maxRps: 50,
  authorized: true,
};

describe('validateConfig', () => {
  it('accepts an allowed target', () => {
    expect(() => validateConfig(base, ['localhost'])).not.toThrow();
  });

  it('rejects an unauthorized test', () => {
    expect(() => validateConfig({ ...base, authorized: false }, ['localhost'])).toThrow(
      InvalidConfigError,
    );
  });

  it('rejects a target outside the allowlist', () => {
    expect(() => validateConfig({ ...base, url: 'http://example.com/' }, ['localhost'])).toThrow(
      TargetNotAllowedError,
    );
  });

  it('requires a positive maxRps cap', () => {
    expect(() => validateConfig({ ...base, maxRps: 0 }, ['localhost'])).toThrow(InvalidConfigError);
  });

  it('bounds concurrency', () => {
    expect(() => validateConfig({ ...base, concurrency: 5000 }, ['localhost'])).toThrow(
      InvalidConfigError,
    );
  });
});

describe('buildEndpointPicker', () => {
  const eps = [
    { url: 'http://h/a', weight: 3 },
    { url: 'http://h/b', weight: 1 },
  ];
  it('selects by cumulative weight', () => {
    const pick = buildEndpointPicker(eps);
    expect(pick(0).url).toBe('http://h/a'); // 0.0 → a
    expect(pick(0.7).url).toBe('http://h/a'); // 0.7*4=2.8 < 3 → a
    expect(pick(0.8).url).toBe('http://h/b'); // 0.8*4=3.2 ≥ 3 → b
    expect(pick(0.999).url).toBe('http://h/b');
  });
  it('defaults missing weights to 1', () => {
    const pick = buildEndpointPicker([{ url: 'http://h/x' }, { url: 'http://h/y' }]);
    expect(pick(0.4).url).toBe('http://h/x');
    expect(pick(0.6).url).toBe('http://h/y');
  });
});

describe('validateConfig endpoint mix', () => {
  const cfg = (over: Partial<LoadTestConfig>): LoadTestConfig => ({ ...base, ...over });
  it('accepts a valid mix', () => {
    expect(() =>
      validateConfig(
        cfg({
          endpoints: [{ url: 'http://localhost/a' }, { url: 'http://localhost/b', weight: 2 }],
        }),
        ['localhost'],
      ),
    ).not.toThrow();
  });
  it('rejects an endpoint outside the allowlist', () => {
    expect(() =>
      validateConfig(cfg({ endpoints: [{ url: 'http://evil.example/a' }] }), ['localhost']),
    ).toThrow(TargetNotAllowedError);
  });
  it('rejects mixing flow and endpoints', () => {
    expect(() =>
      validateConfig(
        cfg({
          flow: [{ method: 'GET', url: 'http://localhost/a' }],
          endpoints: [{ url: 'http://localhost/b' }],
        }),
        ['localhost'],
      ),
    ).toThrow(InvalidConfigError);
  });
  it('rejects an all-zero weight mix', () => {
    expect(() =>
      validateConfig(cfg({ endpoints: [{ url: 'http://localhost/a', weight: 0 }] }), ['localhost']),
    ).toThrow(InvalidConfigError);
  });
});

describe('builtin engine — response assertions', () => {
  let base: string;
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.statusCode = 200;
      res.end('hello world');
      return;
    }
    res.statusCode = 500;
    res.end('boom');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const cfg = (over: Partial<LoadTestConfig>): LoadTestConfig => ({
    url: `${base}/ok`,
    concurrency: 2,
    durationSec: 1,
    maxRps: 20,
    authorized: true,
    ...over,
  });

  it('counts checks and reports zero failures when the response matches', async () => {
    const r = await runLoadTest(cfg({ assertion: { status: 200, bodyContains: 'hello' } }), [
      '127.0.0.1',
    ]);
    expect(r.assertionsChecked).toBeGreaterThan(0);
    expect(r.assertionsChecked).toBe(r.totalRequests);
    expect(r.assertionFailures).toBe(0);
  });

  it('flags failures on a status/body mismatch', async () => {
    const r = await runLoadTest(
      cfg({ url: `${base}/nope`, assertion: { status: 200, bodyContains: 'hello' } }),
      ['127.0.0.1'],
    );
    expect(r.assertionsChecked).toBeGreaterThan(0);
    expect(r.assertionFailures).toBe(r.assertionsChecked);
  });

  it('does not check when no assertion is set', async () => {
    const r = await runLoadTest(cfg({}), ['127.0.0.1']);
    expect(r.assertionsChecked).toBe(0);
    expect(r.assertionFailures).toBe(0);
  });
});

describe('builtin engine — endpoint mix', () => {
  let base: string;
  const seen: Record<string, number> = {};
  const server = createServer((req, res) => {
    seen[req.url ?? ''] = (seen[req.url ?? ''] ?? 0) + 1;
    res.statusCode = 200;
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('spreads requests across the weighted endpoints', async () => {
    const r = await runLoadTest(
      {
        url: `${base}/`,
        concurrency: 3,
        durationSec: 2,
        maxRps: 30,
        authorized: true,
        endpoints: [
          { url: `${base}/a`, weight: 3 },
          { url: `${base}/b`, weight: 1 },
        ],
      },
      ['127.0.0.1'],
    );
    expect(r.totalRequests).toBeGreaterThan(0);
    // Both endpoints were hit, and the heavier weight got more traffic.
    expect(seen['/a']).toBeGreaterThan(0);
    expect(seen['/b']).toBeGreaterThan(0);
    expect(seen['/a']).toBeGreaterThan(seen['/b']);
  }, 15000);
});

describe('builtin engine — User-Agent rotation', () => {
  let base: string;
  const uas = new Set<string>();
  const server = createServer((req, res) => {
    uas.add(req.headers['user-agent'] ?? '');
    res.statusCode = 200;
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rotates the User-Agent across requests', async () => {
    await runLoadTest(
      {
        url: `${base}/`,
        concurrency: 3,
        durationSec: 2,
        maxRps: 30,
        authorized: true,
        userAgents: ['AgentOne/1.0', 'AgentTwo/2.0', 'AgentThree/3.0'],
      },
      ['127.0.0.1'],
    );
    // Several of the configured UAs were actually sent.
    const sent = [...uas].filter((u) => u.startsWith('Agent'));
    expect(sent.length).toBeGreaterThan(1);
  }, 15000);
});

describe('builtin engine — data feeder', () => {
  let base: string;
  const paths = new Set<string>();
  const server = createServer((req, res) => {
    paths.add(req.url ?? '');
    res.statusCode = 200;
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('substitutes dataset columns into the URL per request', async () => {
    await runLoadTest(
      {
        url: `${base}/search?q={{q}}`,
        concurrency: 3,
        durationSec: 2,
        maxRps: 30,
        authorized: true,
        dataset: [{ q: 'apple' }, { q: 'banana' }],
      },
      ['127.0.0.1'],
    );
    expect([...paths].some((p) => p.includes('q=apple'))).toBe(true);
    expect([...paths].some((p) => p.includes('q=banana'))).toBe(true);
    expect([...paths].some((p) => p.includes('{{q}}'))).toBe(false);
  }, 15000);
});

describe('builtin engine — redirects are not followed (allowlist/SSRF guard)', () => {
  let primary: string;
  let secondaryHits = 0;
  // The "secondary" stands in for an off-allowlist host a redirect could point
  // at. If the engine ever follows a 3xx, this server records the hit.
  const secondary = createServer((_req, res) => {
    secondaryHits++;
    res.statusCode = 200;
    res.end('should-never-be-reached');
  });
  // The primary (allowlisted target) always answers with a 302 to the secondary.
  const server = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `http://127.0.0.1:${(secondary.address() as AddressInfo).port}/`);
    res.end();
  });

  beforeAll(async () => {
    await new Promise<void>((r) => secondary.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    primary = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => secondary.close(() => r()));
  });

  it('records the 3xx as-is and never chases the redirect off-allowlist', async () => {
    const r = await runLoadTest(
      { url: `${primary}/`, concurrency: 3, durationSec: 1, maxRps: 30, authorized: true },
      ['127.0.0.1'],
    );
    expect(r.totalRequests).toBeGreaterThan(0);
    expect(r.statusCounts['3xx']).toBe(r.totalRequests); // every response is the 302
    expect(secondaryHits).toBe(0); // the redirect target was never contacted
  });
});
