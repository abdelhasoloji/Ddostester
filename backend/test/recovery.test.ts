import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitForTargetAvailable } from '../src/modules/campaigns/recovery.js';

/** Spins up a tiny server whose status code is decided per request by `code()`. */
function server(code: () => number): { srv: Server; url: () => string } {
  const srv = createServer((_q, r) => {
    r.statusCode = code();
    r.end('x');
  });
  return { srv, url: () => `http://127.0.0.1:${(srv.address() as AddressInfo).port}/` };
}

describe('waitForTargetAvailable (between-wave recovery gate)', () => {
  it('reports available quickly for a healthy target', async () => {
    const { srv, url } = server(() => 200);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const res = await waitForTargetAvailable(url(), {
        needed: 1,
        intervalMs: 20,
        maxWaitMs: 2000,
      });
      expect(res.available).toBe(true);
      expect(res.waitedMs).toBeLessThan(1000);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('reports unavailable (bounded) when nothing is listening', async () => {
    // Port 1 refuses immediately on loopback.
    const res = await waitForTargetAvailable('http://127.0.0.1:1/', {
      needed: 1,
      intervalMs: 30,
      maxWaitMs: 300,
      requestTimeoutMs: 150,
    });
    expect(res.available).toBe(false);
    expect(res.waitedMs).toBeLessThan(2000);
    expect(res.checks).toBeGreaterThanOrEqual(1);
  });

  it('treats a 5xx as still-unavailable (origin struggling)', async () => {
    const { srv, url } = server(() => 503);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const res = await waitForTargetAvailable(url(), {
        needed: 1,
        intervalMs: 20,
        maxWaitMs: 250,
      });
      expect(res.available).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('recovers once the target stops erroring', async () => {
    let n = 0;
    const { srv, url } = server(() => (n++ < 2 ? 500 : 200)); // 500, 500, then 200…
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const res = await waitForTargetAvailable(url(), {
        needed: 2,
        intervalMs: 20,
        maxWaitMs: 3000,
      });
      expect(res.available).toBe(true);
      expect(res.checks).toBeGreaterThanOrEqual(4); // 2 errors + 2 healthy
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('returns immediately when cancelled', async () => {
    const res = await waitForTargetAvailable('http://127.0.0.1:1/', {
      isCancelled: () => true,
      maxWaitMs: 60_000,
    });
    expect(res.available).toBe(false);
    expect(res.checks).toBe(0);
  });
});

it('clips polling sleep to the remaining recovery budget', async () => {
  const result = await waitForTargetAvailable('http://fixture.test/', {
    maxWaitMs: 40,
    intervalMs: 1000,
    needed: 1,
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  });
  expect(result.available).toBe(false);
  expect(result.waitedMs).toBeLessThan(500);
  expect(result.checks).toBe(1);
});
