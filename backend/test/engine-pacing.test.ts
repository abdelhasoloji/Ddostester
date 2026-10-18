import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runLoadTest } from '../src/engine/loadTest.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function startRecorder(arrivals: number[]): Promise<number> {
  server = createServer((_req, res) => {
    arrivals.push(Date.now());
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Largest number of arrivals inside any window of `windowMs`. */
function peakInWindow(arrivals: number[], windowMs: number): number {
  const sorted = [...arrivals].sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > windowMs) start++;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

describe('global pacing (M1.2)', () => {
  it('spreads a 100 rps run instead of releasing it as one per-second burst', async () => {
    const arrivals: number[] = [];
    const port = await startRecorder(arrivals);

    const result = await runLoadTest(
      {
        url: `http://127.0.0.1:${port}/`,
        concurrency: 20,
        durationSec: 1,
        maxRps: 100,
        authorized: true,
      },
      ['127.0.0.1'],
    );

    // The rate cap still holds end to end.
    expect(result.totalRequests).toBeGreaterThanOrEqual(80);
    expect(result.totalRequests).toBeLessThanOrEqual(120);

    // The 1-second window pacer put ~100 requests in the first 100 ms. A paced
    // 100 rps run has ~10 per 100 ms; allow generous scheduler noise on CI.
    expect(peakInWindow(arrivals, 100)).toBeLessThanOrEqual(35);
  }, 20_000);

  it('holds the same spacing when a run outlives one window', async () => {
    const arrivals: number[] = [];
    const port = await startRecorder(arrivals);

    const result = await runLoadTest(
      {
        url: `http://127.0.0.1:${port}/`,
        concurrency: 10,
        durationSec: 2,
        maxRps: 50,
        authorized: true,
      },
      ['127.0.0.1'],
    );

    expect(result.totalRequests).toBeGreaterThanOrEqual(80);
    expect(result.totalRequests).toBeLessThanOrEqual(120);
    expect(peakInWindow(arrivals, 200)).toBeLessThanOrEqual(35);
  }, 20_000);
});
