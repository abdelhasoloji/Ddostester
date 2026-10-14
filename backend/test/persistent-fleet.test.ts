import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindPersistentFleet, PersistentFleetHttpAgent } from '../src/agents/persistent-fleet.js';
import { latencyHistogram } from '../src/engine/stats.js';
import { LATENCY_BUCKETS_MS } from '../src/config/limits.js';
const config = {
  url: 'http://target.test/',
  authorized: true,
  maxRps: 3,
  concurrency: 3,
  durationSec: 20,
  headers: { 'X-WEDOS-TEST': 'campaign:trace' },
};
const shard = (agentId: string, state = 'SUCCEEDED') => ({
  agentId,
  state,
  attemptId: agentId,
  leaseUntil: Date.now() + 6000,
  result: {
    generator: {
      totalRequests: 1,
      successful: 1,
      failed: 0,
      latencyMs: { min: 10, max: 10 },
      latencyHistogram: latencyHistogram([10], LATENCY_BUCKETS_MS),
      statusCounts: { '2xx': 1 },
      errors: {},
    },
  },
});
describe('enrolled Fleet campaign engine', () => {
  let unbind: (() => void) | undefined;
  afterEach(() => {
    unbind?.();
    vi.useRealTimers();
  });
  it('keeps agent evidence and aggregate progress in the parent campaign result', async () => {
    const start = vi.fn(async () => 'fleet-run');
    const stop = vi.fn(async () => {});
    unbind = bindPersistentFleet({
      start,
      stop,
      snapshot: async () => ({
        state: 'SETTLED',
        shards: ['one', 'two', 'three'].map((id) => shard(id)),
      }),
    });
    const progress = vi.fn();
    const result = await new PersistentFleetHttpAgent().run(
      config,
      ['target.test'],
      undefined,
      progress,
    );
    expect(start).toHaveBeenCalledWith(config, ['target.test']);
    expect(result.totalRequests).toBe(3);
    expect(result.fleet?.shards).toHaveLength(3);
    expect(result.fleet?.measurementComplete).toBe(true);
    expect(progress.mock.calls[0][0]).toMatchObject({ runId: 'fleet-run', sent: 3, successful: 3 });
    expect(stop).toHaveBeenCalledWith('fleet-run');
  });
  it('waits for all stop receipts rather than treating the stop order as completion', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let stopped = false;
    const stop = vi.fn(async () => {
      stopped = true;
    });
    unbind = bindPersistentFleet({
      start: async () => 'fleet-run',
      stop,
      snapshot: async () => ({
        state: stopped ? 'SETTLED' : 'RUNNING',
        shards: ['one', 'two', 'three'].map((id) => shard(id, stopped ? 'STOPPED' : 'RUNNING')),
      }),
    });
    const run = new PersistentFleetHttpAgent().run(config, ['target.test'], abort.signal);
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(300);
    const result = await run;
    expect(result.fleet?.shards.every((s) => s.state === 'STOPPED')).toBe(true);
    expect(result.fleet?.measurementComplete).toBe(false);
    expect(stop).toHaveBeenCalled();
  });
  it('rejects unsupported or oversized work before creating any assignment', async () => {
    const start = vi.fn(async () => 'forbidden');
    unbind = bindPersistentFleet({ start, stop: async () => {}, snapshot: async () => null });
    for (const over of [
      { maxRps: 16 },
      { method: 'POST' as const },
      { durationSec: 61 },
      { endpoints: [{ url: config.url }] },
    ])
      await expect(
        new PersistentFleetHttpAgent().run({ ...config, ...over }, ['target.test']),
      ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
});
