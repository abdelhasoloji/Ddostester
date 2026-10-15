import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import { it, expect, vi, afterEach } from 'vitest';
import { captureDrsBaseline, DrsBaselineError } from '../src/modules/drs/baseline.js';
import type { DrsPlan } from '../src/modules/drs/model.js';
afterEach(() => vi.useRealTimers());
const plan = { baselineMinSec: 300, baselineStabilityTolerance: 0.1 } as DrsPlan;
it('takes at least five minutes of independent low-rate samples and retains distributions without claiming functional transactions', async () => {
  const capture = vi.fn().mockResolvedValue({
    samples: 301,
    samplesMs: Array(301).fill(10),
    durationSec: 300,
    availabilityPct: 100,
    latencyMs: { p50: 10, p95: 10 },
  });
  const r = await captureDrsBaseline(
    'http://lab-target/',
    plan,
    new AbortController().signal,
    undefined,
    capture,
  );
  expect(capture.mock.calls[0].slice(2, 5)).toEqual([301, 1000, 5000]);
  expect(r.samplesMs).toHaveLength(301);
  expect(r.functionalAssertionMeasured).toBe(false);
});
it('extends unstable observations and refuses an unhealthy or cancelled baseline', async () => {
  const capture = vi.fn().mockResolvedValue({
    samples: 301,
    samplesMs: [1, 100],
    durationSec: 300,
    availabilityPct: 100,
    latencyMs: { p50: 1, p95: 100 },
  });
  await expect(
    captureDrsBaseline(
      'http://lab-target/',
      plan,
      new AbortController().signal,
      undefined,
      capture,
    ),
  ).rejects.toThrow(/unstable|incomplete/);
  expect(capture.mock.calls.length).toBeGreaterThan(1);
  const unhealthy = vi.fn().mockResolvedValue({
    samples: 301,
    samplesMs: Array(301).fill(10),
    durationSec: 300,
    availabilityPct: 90,
    latencyMs: { p50: 10, p95: 10 },
  });
  await expect(
    captureDrsBaseline(
      'http://lab-target/',
      plan,
      new AbortController().signal,
      undefined,
      unhealthy,
    ),
  ).rejects.toThrow(/unhealthy/);
});

it('refuses simulation in the physical runner before any destination or network work', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(
      executeCampaign(
        {
          drsMode: 'engine-validation',
          target: 'http://lab-target/',
          probeUrl: 'http://lab-target/',
        } as Campaign,
        ['lab-target'],
        new KillSwitch(),
      ),
    ).rejects.toThrow(/Simulation/);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it('keeps slow response time out of the sampling interval and completes the first window', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Response('healthy');
  });
  try {
    const pending = captureDrsBaseline('http://lab-target/', plan, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(301000);
    const result = await pending;
    expect(result.samples).toBe(301);
    expect(result.durationSec).toBeGreaterThanOrEqual(300);
    expect(result.durationSec).toBeLessThan(301);
    expect(result.stable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(301);
  } finally {
    fetch.mockRestore();
  }
});

it('extends in small batches until the complete distribution converges, without discarding outliers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const initial = Array.from({ length: 301 }, (_, i) => (i % 2 ? 9 : 11.2));
  let calls = 0;
  const capture = vi.fn(async (_url, _signal, count) => {
    calls++;
    const durationSec = calls === 1 ? 300 : count - 1;
    await vi.advanceTimersByTimeAsync(durationSec * 1000);
    return {
      samples: count,
      samplesMs: calls === 1 ? initial : Array(count).fill(10.1),
      durationSec,
      availabilityPct: 100,
      latencyMs: { p50: 10.1, p95: 11.2 },
    };
  });
  const result = await captureDrsBaseline(
    'http://lab-target/',
    plan,
    new AbortController().signal,
    undefined,
    capture,
  );
  expect(calls).toBeGreaterThan(2);
  expect(result.samplesMs?.slice(0, 301)).toEqual(initial);
  expect(result.durationSec).toBeGreaterThan(300);
  expect(result.durationSec).toBeLessThan(600);
  expect(result.stable).toBe(true);
});

it('retains the rejected distribution and its exact cause before the observation deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let calls = 0;
  const capture = vi.fn(async (_url, _signal, count) => {
    const durationSec = calls++ === 0 ? 300 : count - 1;
    await vi.advanceTimersByTimeAsync(durationSec * 1000);
    return {
      samples: count,
      samplesMs: Array.from({ length: count }, (_, i) => (i % 2 ? 1 : 100)),
      durationSec,
      availabilityPct: 100,
      latencyMs: { p50: 1, p95: 100 },
    };
  });
  const err = await captureDrsBaseline(
    'http://lab-target/',
    plan,
    new AbortController().signal,
    undefined,
    capture,
  ).catch((e) => e);
  expect(err).toBeInstanceOf(DrsBaselineError);
  expect(err.diagnostic.reason).toBe('unstable');
  expect(err.diagnostic.coefficientOfVariation).toBeGreaterThan(0.1);
  expect(err.diagnostic.samplesMs.length).toBe(err.diagnostic.samples);
  expect(err.diagnostic.elapsedSec).toBeLessThan(600);
  expect(err.message).toContain('no injection');
});

it('distinguishes cancellation from instability without making a probe request', async () => {
  const parent = new AbortController();
  parent.abort();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const err = await captureDrsBaseline('http://lab-target/', plan, parent.signal).catch((e) => e);
    expect(err.diagnostic).toMatchObject({
      reason: 'cancelled',
      samples: 0,
      coefficientOfVariation: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
