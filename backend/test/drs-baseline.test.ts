import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import { it, expect, vi } from 'vitest';
import { captureDrsBaseline } from '../src/modules/drs/baseline.js';
import type { DrsPlan } from '../src/modules/drs/model.js';
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
  ).rejects.toThrow(/unstable/);
  expect(capture).toHaveBeenCalledTimes(2);
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
