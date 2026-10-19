import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VegetaAgent } from '../src/agents/vegeta.js';

describe('Vegeta cancelled-run evidence', () => {
  it('still parses retained results after emission has been aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegeta-cancellation-'));
    const bin = join(dir, 'vegeta');
    // Deterministic process fixture: no network traffic is emitted.
    await writeFile(
      bin,
      `#!${process.execPath}
const command = process.argv[2];
if (command === '-version') process.exit(0);
if (command === 'attack') {
 process.stdout.write('retained-observation');
 (await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, 'started'))}, 'ready');
 setInterval(() => {}, 1000);
} else if (command === 'encode') {
 process.stdin.resume();
} else if (command === 'report') {
 console.log(JSON.stringify({requests:1,success:1,status_codes:{'200':1},rate:1}));
} else process.exit(2);
`,
    );
    await chmod(bin, 0o700);
    const controller = new AbortController();
    try {
      const agent = new VegetaAgent(bin);
      vi.spyOn(agent, 'available').mockResolvedValue(true);
      const pending = agent.run(
        {
          url: 'http://127.0.0.1/',
          authorized: true,
          concurrency: 1,
          durationSec: 5,
          maxRps: 1,
        },
        ['127.0.0.1'],
        controller.signal,
      );
      await vi.waitFor(() => access(join(dir, 'started')), { timeout: 10_000 });
      controller.abort();
      const result = await pending;
      expect(controller.signal.aborted).toBe(true);
      expect(result.totalRequests).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.latencyMethod).toBe('native-combined-results');
    } finally {
      controller.abort();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
