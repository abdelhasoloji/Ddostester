import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { runSlowloris } from '../src/engine/slowloris.js';
import { TargetNotAllowedError, InvalidConfigError } from '../src/engine/loadTest.js';
import type { LoadTestConfig } from '../src/engine/types.js';

// A throwaway TCP server that just accepts and holds connections (never replies),
// so we can observe SlowLoris opening + holding bounded connections locally.
const server = net.createServer((s) => {
  s.on('error', () => undefined);
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      const done = () => r();
      const s = server as net.Server & { closeAllConnections?: () => void };
      s.closeAllConnections?.();
      server.close(done);
      setTimeout(done, 500).unref(); // fallback: never block the suite on teardown
    }),
);

function cfg(over: Partial<LoadTestConfig> = {}): LoadTestConfig {
  return {
    url: `http://127.0.0.1:${port}/`,
    concurrency: 5,
    durationSec: 1,
    maxRps: 10,
    slowloris: true,
    authorized: true,
    ...over,
  } as LoadTestConfig;
}

describe('SlowLoris vector (bounded slow-header hold)', () => {
  it('opens and holds up to `concurrency` connections against an allowlisted target', async () => {
    const res = await runSlowloris(cfg(), ['127.0.0.1']);
    expect(res.totalRequests).toBe(5); // opened exactly `concurrency` connections
    // The dummy server holds them, so they are still held at the end (none shed).
    expect(res.successful).toBe(5);
    expect(res.failed).toBe(0);
    expect(res.latencyMs.p95).toBe(0); // no completed requests — it's a hold vector
  });

  it('stops immediately on the kill signal', async () => {
    const ac = new AbortController();
    const p = runSlowloris(cfg({ durationSec: 60 }), ['127.0.0.1'], ac.signal);
    setTimeout(() => ac.abort(), 300);
    const res = await p;
    expect(res.totalRequests).toBe(5);
  });

  it('refuses a target outside the allowlist', async () => {
    await expect(runSlowloris(cfg({ url: 'http://evil.example/' }), ['127.0.0.1'])).rejects.toThrow(
      TargetNotAllowedError,
    );
  });

  it('refuses when not authorized', async () => {
    await expect(runSlowloris(cfg({ authorized: false }), ['127.0.0.1'])).rejects.toThrow(
      InvalidConfigError,
    );
  });
});
