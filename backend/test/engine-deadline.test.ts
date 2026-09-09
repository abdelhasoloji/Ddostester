import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { runLoadTest } from '../src/engine/loadTest.js';

// Tarpit target: accept the TCP connection but never send a response — the
// worst case for a load run against a target that WEDOS protection black-holes.
const server = http.createServer(() => {
  /* never respond; hold the connection open */
});
let url = '';
async function start(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  url = `http://127.0.0.1:${port}/`;
}
afterAll(() => server.close());

describe('engine honours its deadline against a tarpit target', () => {
  it('a 2s multi-phase run stops within a small margin of its deadline', async () => {
    await start();
    const started = Date.now();
    const res = await runLoadTest(
      {
        url,
        method: 'GET',
        concurrency: 10,
        maxRps: 100,
        durationSec: 2,
        phases: [
          { maxRps: 100, durationSec: 1 },
          { maxRps: 20, durationSec: 1 },
        ],
        timeoutMs: 500,
        authorized: true,
      } as never,
      ['127.0.0.1'],
    );
    const elapsed = (Date.now() - started) / 1000;
    // Deadline is 2s; requests time out at 500ms. It must finish well under 5s.
    expect(elapsed).toBeLessThan(5);
    expect(res.failed).toBeGreaterThan(0);
  }, 20_000);
});
