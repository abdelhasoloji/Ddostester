import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureBaseline, computeBaselineDelta } from '../src/modules/campaigns/baseline.js';

describe('computeBaselineDelta', () => {
  it('reports latency increase and availability drop under load', () => {
    const d = computeBaselineDelta(
      { samples: 3, availabilityPct: 100, latencyMs: { p50: 10, p95: 20 } },
      { availabilityPct: 80, latencyMs: { p50: 35, p95: 90 } },
    );
    expect(d!.latencyP50DeltaMs).toBe(25);
    expect(d!.latencyP95DeltaMs).toBe(70);
    expect(d!.availabilityDeltaPct).toBe(-20);
  });

  it('is zero when nothing changed', () => {
    const same = { availabilityPct: 100, latencyMs: { p50: 5, p95: 9 } };
    expect(computeBaselineDelta({ samples: 3, ...same }, same)).toEqual({
      latencyP50DeltaMs: 0,
      latencyP95DeltaMs: 0,
      availabilityDeltaPct: 0,
    });
  });
});

describe('captureBaseline', () => {
  let base: string;
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('records full availability against a healthy target', async () => {
    const b = await captureBaseline(`${base}/`, undefined, 2, 10, 500);
    expect(b.samples).toBe(2);
    expect(b.availabilityPct).toBe(100);
    expect(b.latencyMs.p50).toBeGreaterThanOrEqual(0);
  });

  it('records zero availability against an unreachable target (never throws)', async () => {
    const b = await captureBaseline('http://127.0.0.1:1/', undefined, 1, 10, 200);
    expect(b.availabilityPct).toBe(0);
  });

  it('stops early when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const b = await captureBaseline(`${base}/`, ac.signal, 3, 10, 500);
    expect(b.samples).toBe(0);
  });
});

it('withholds comparison when remote baseline observations are missing', () => {
  expect(
    computeBaselineDelta(
      {
        samples: 3,
        availabilityPct: 0,
        latencyMs: { p50: 0, p95: 0 },
        observation: {
          vantage: 'remote',
          expectedSamples: 3,
          receivedSamples: 0,
          missingSamples: 3,
          complete: false,
        },
      },
      { availabilityPct: 100, latencyMs: { p50: 10, p95: 20 } },
    ),
  ).toBeUndefined();
});

it('withholds baseline comparison when the probe process was contended', () => {
  const quality = {
    measuredSamples: 3,
    totalSamples: 3,
    eventLoopMeasuredSamples: 3,
    peakEventLoopDelayMs: 150,
    peakRecentEventLoopDelayMs: null,
    peakThrottledFraction: 0,
  };
  expect(
    computeBaselineDelta(
      { samples: 3, availabilityPct: 100, latencyMs: { p50: 10, p95: 20 }, quality },
      { availabilityPct: 100, latencyMs: { p50: 20, p95: 40 } },
    ),
  ).toBeUndefined();
});
