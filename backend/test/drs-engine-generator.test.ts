import { describe, it, expect, vi } from 'vitest';
import { createEngineGeneratorPort } from '../src/modules/drs/engine-generator.js';

const budget = { maxRps: 200, concurrency: 20, maxAgents: 1, maxDurationSec: 10 };
const ceiling = { maxRps: 500, maxConcurrency: 50, maxDurationSec: 30, maxAgents: 3 };

const fakeRun = (behaviour: 'finish' | 'wait') =>
  vi.fn(async (_c: unknown, _h: string[], signal?: AbortSignal) => {
    if (behaviour === 'wait')
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    return { totalRequests: 42, actualRps: 20 } as never;
  });

describe('engine generator port', () => {
  it('refuses a budget above the service ceiling instead of silently capping', async () => {
    const port = createEngineGeneratorPort({
      url: 'http://x/',
      allowedHosts: ['x'],
      ceiling,
      run: fakeRun('finish'),
    });
    await expect(port.capacity(['v1'], { ...budget, maxRps: 900 })).resolves.toMatchObject({
      ready: false,
    });
    expect((await port.capacity(['v1'], { ...budget, maxRps: 900 })).reason).toContain('900');
  });

  it('is ready inside the ceiling and reports the measured result after stop', async () => {
    const run = fakeRun('wait');
    const port = createEngineGeneratorPort({ url: 'http://x/', allowedHosts: ['x'], ceiling, run });
    await expect(port.capacity(['v1'], budget)).resolves.toMatchObject({ ready: true });
    const signal = new AbortController();
    const handle = await port.start(['v1'], budget, signal.signal);
    const receipt = await handle.stop();
    expect(receipt.confirmed).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(port.last).toMatchObject({ totalRequests: 42 });
  });

  it('refuses to start with no vector selected', async () => {
    const port = createEngineGeneratorPort({
      url: 'http://x/',
      allowedHosts: ['x'],
      ceiling,
      run: fakeRun('finish'),
    });
    await expect(port.capacity([], budget)).resolves.toMatchObject({ ready: false });
  });
});
