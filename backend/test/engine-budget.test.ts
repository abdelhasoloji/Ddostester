import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { runLoadTest, validateConfig } from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';
const base: LoadTestConfig = {
  url: 'http://127.0.0.1/',
  concurrency: 1,
  durationSec: 1,
  maxRps: 1,
  authorized: true,
};
describe('engine budget clocks and numeric bounds', () => {
  it.each([
    { concurrency: NaN },
    { concurrency: 1.5 },
    { durationSec: NaN },
    { maxRps: Infinity },
    { phases: [{ maxRps: Infinity, durationSec: 1 }] },
    { phases: [{ maxRps: 1, durationSec: Infinity }] },
  ])('rejects invalid resource budgets before I/O: %j', (change) => {
    expect(() => validateConfig({ ...base, ...change }, ['127.0.0.1'])).toThrow();
  });
  it('finishes on its monotonic budget when the wall clock moves backwards', async () => {
    const server = createServer((_req, response) => response.end('isolated clock fixture'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
    const controller = new AbortController();
    const safety = setTimeout(() => controller.abort(), 1800);
    const oldClock = Date.now() - 3600_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(oldClock);
    const began = performance.now();
    try {
      const result = await runLoadTest(
        { ...base, url: `http://127.0.0.1:${address.port}/` },
        ['127.0.0.1'],
        controller.signal,
      );
      expect(result.totalRequests).toBe(1);
      expect(controller.signal.aborted).toBe(false);
      expect(performance.now() - began).toBeLessThan(1500);
    } finally {
      clock.mockRestore();
      clearTimeout(safety);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
