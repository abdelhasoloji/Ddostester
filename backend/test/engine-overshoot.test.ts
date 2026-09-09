import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { runLoadTest } from '../src/engine/loadTest.js';

const server = http.createServer((_req, res) => res.end('ok'));
let url = '';
async function start(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
}
afterAll(() => server.close());

describe('engine deadline vs maxDurationSec (durationSec) cap', () => {
  it('a run whose phases sum BEYOND durationSec must still stop at durationSec', async () => {
    await start();
    const started = Date.now();
    await runLoadTest(
      {
        url,
        method: 'GET',
        concurrency: 4,
        maxRps: 50,
        durationSec: 1, // the campaign's stated max duration
        phases: [
          { maxRps: 50, durationSec: 2 },
          { maxRps: 50, durationSec: 2 }, // phases sum to 4s >> durationSec 1s
        ],
        timeoutMs: 500,
        authorized: true,
      } as never,
      ['127.0.0.1'],
    );
    const elapsed = (Date.now() - started) / 1000;
    console.log('elapsed', elapsed.toFixed(2), 's (durationSec cap was 1s, phases sum 4s)');
    // EXPECTED after fix: ~1s. If it runs ~4s, the run overshoots its maxDurationSec.
    expect(elapsed).toBeLessThan(2);
  }, 20_000);
});
