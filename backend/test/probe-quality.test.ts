import { expect, it } from 'vitest';
import { validateRemoteSample } from '../src/modules/probe/remote.js';
import { remoteProbeQualityReasons } from '../src/modules/reports/confidence.js';

const quality = {
  schema: 'ddostester.probe.quality/v1',
  scope: 'process-during-measurement',
  elapsedMs: 1000,
  cpuUserUsec: 1200,
  cpuSystemUsec: 300,
  rssBytes: 100000,
  eventLoopDelayMaxMs: null,
  cgroupThrottledUsecDelta: null,
  sampledAt: '2026-10-13T17:00:00.000Z',
};
it('keeps null diagnostics and backwards-compatible samples without inventing zeroes', () => {
  expect(
    validateRemoteSample({ ok: true, status: 200, latencyMs: 10, quality }, 1000).quality,
  ).toEqual(quality);
  expect(
    validateRemoteSample({ ok: true, status: 200, latencyMs: 10 }, 1000).quality,
  ).toBeUndefined();
});
it('rejects malformed, nonfinite and negative resource diagnostics', () => {
  for (const invalid of [
    { ...quality, rssBytes: -1 },
    { ...quality, elapsedMs: Infinity },
    { ...quality, schema: 'other' },
    { ...quality, sampledAt: 'wrong' },
  ])
    expect(() =>
      validateRemoteSample({ ok: true, status: 200, latencyMs: 10, quality: invalid }, 1000),
    ).toThrow('quality');
});
it('flags missing coverage and probe contention separately from target attribution', () => {
  expect(remoteProbeQualityReasons()).toHaveLength(1);
  expect(
    remoteProbeQualityReasons({
      measuredSamples: 10,
      totalSamples: 10,
      peakEventLoopDelayMs: 150,
      peakThrottledFraction: 0.2,
    }),
  ).toHaveLength(2);
  expect(
    remoteProbeQualityReasons({
      measuredSamples: 10,
      totalSamples: 10,
      peakEventLoopDelayMs: null,
      peakThrottledFraction: null,
    }),
  ).toHaveLength(1);
});

it('accepts recent process windows separately and rejects malformed coverage', () => {
  const recentEventLoop = {
    scope: 'process-recent-window',
    windowMs: 10000,
    samples: 400,
    maxMs: 175,
  };
  const sample = { ok: true, status: 200, latencyMs: 10, quality: { ...quality, recentEventLoop } };
  expect(validateRemoteSample(sample, 1000).quality?.recentEventLoop).toEqual(recentEventLoop);
  for (const invalid of [
    { ...recentEventLoop, samples: 0 },
    { ...recentEventLoop, maxMs: NaN },
    { ...recentEventLoop, windowMs: -1 },
    { ...recentEventLoop, scope: 'request' },
  ]) {
    expect(() =>
      validateRemoteSample({ ...sample, quality: { ...quality, recentEventLoop: invalid } }, 1000),
    ).toThrow('quality');
  }
  expect(
    remoteProbeQualityReasons({
      measuredSamples: 10,
      totalSamples: 10,
      peakEventLoopDelayMs: null,
      peakRecentEventLoopDelayMs: 175,
      peakThrottledFraction: 0,
    }),
  ).toEqual([expect.stringContaining('exceeded 100ms')]);
  expect(
    remoteProbeQualityReasons({
      measuredSamples: 10,
      totalSamples: 10,
      peakEventLoopDelayMs: null,
      peakRecentEventLoopDelayMs: 25,
      peakThrottledFraction: 0,
    }),
  ).toEqual([]);
});

it('does not let one recent diagnostic stand in for complete event-loop coverage', () => {
  expect(
    remoteProbeQualityReasons({
      measuredSamples: 10,
      totalSamples: 10,
      peakEventLoopDelayMs: null,
      peakRecentEventLoopDelayMs: 25,
      peakThrottledFraction: 0,
      eventLoopMeasuredSamples: 1,
    }),
  ).toEqual([expect.stringContaining('less than 90%')]);
});
