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

describe('engine abort (kill switch / suite cancel)', () => {
  it('aborting mid-run stops the run promptly', async () => {
    await start();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const started = Date.now();
    await runLoadTest(
      {
        url,
        method: 'GET',
        concurrency: 4,
        maxRps: 50,
        durationSec: 30,
        timeoutMs: 500,
        authorized: true,
      } as never,
      ['127.0.0.1'],
      ac.signal,
    );
    const elapsed = (Date.now() - started) / 1000;
    console.log(
      'aborted run elapsed',
      elapsed.toFixed(2),
      's (durationSec was 30s, aborted at 0.4s)',
    );
    expect(elapsed).toBeLessThan(2);
  }, 20_000);
});
