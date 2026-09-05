import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
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
