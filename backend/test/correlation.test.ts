import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  extractValue,
  flowUsesCorrelation,
  substitute,
  usesTemplate,
} from '../src/engine/correlation.js';
import { runLoadTest } from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';

describe('substitute / usesTemplate', () => {
  it('replaces {{vars}} and detects templates', () => {
    expect(substitute('Bearer {{token}}', { token: 'abc' })).toBe('Bearer abc');
    expect(substitute('/u/{{id}}/x', { id: '7' })).toBe('/u/7/x');
    expect(substitute('none', {})).toBe('none');
    expect(usesTemplate('a {{b}}')).toBe(true);
    expect(usesTemplate('plain')).toBe(false);
  });
});

describe('extractValue', () => {
  it('reads a JSON dot-path', () => {
    expect(extractValue('json', 'token', { body: '{"token":"T"}', headers: {} })).toBe('T');
    expect(extractValue('json', 'data.id', { body: '{"data":{"id":9}}', headers: {} })).toBe('9');
  });
  it('reads a header', () => {
    expect(extractValue('header', 'x-token', { body: '', headers: { 'x-token': 'H' } })).toBe('H');
  });
  it('reads a regex capture group', () => {
    expect(extractValue('regex', 'id=(\\w+)', { body: 'id=Z9;', headers: {} })).toBe('Z9');
  });
  it('returns undefined on miss / invalid JSON', () => {
    expect(extractValue('json', 'x', { body: 'not json', headers: {} })).toBeUndefined();
  });
});

describe('flowUsesCorrelation', () => {
  it('is true with extract or {{template}} usage', () => {
    expect(flowUsesCorrelation([{ method: 'GET', url: 'http://h/a' }])).toBe(false);
    expect(
      flowUsesCorrelation([
        { method: 'GET', url: 'http://h/a', extract: { name: 't', from: 'json', expr: 'token' } },
      ]),
    ).toBe(true);
    expect(
      flowUsesCorrelation([
        { method: 'GET', url: 'http://h/a', headers: { Authorization: '{{t}}' } },
      ]),
    ).toBe(true);
  });
});

describe('builtin engine — correlation end to end', () => {
  let base: string;
  let host: string;
  let port: number;
  const seenAuth: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'SECRET123' }));
      return;
    }
    if (req.url?.startsWith('/secure')) {
      seenAuth.push(req.headers['authorization'] ?? '');
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    port = addr.port;
    host = '127.0.0.1';
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('extracts a token at login and injects it into the next step', async () => {
    const config: LoadTestConfig = {
      url: `${base}/login`,
      concurrency: 1,
      durationSec: 1,
      maxRps: 10,
      authorized: true,
      flow: [
        {
          method: 'POST',
          url: `${base}/login`,
          extract: { name: 'token', from: 'json', expr: 'token' },
        },
        { method: 'GET', url: `${base}/secure`, headers: { Authorization: 'Bearer {{token}}' } },
      ],
    };
    const result = await runLoadTest(config, [host]);
    expect(result.totalRequests).toBeGreaterThan(0);
    // Every /secure hit must have carried the token extracted from /login.
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((a) => a === 'Bearer SECRET123')).toBe(true);
  });
});
