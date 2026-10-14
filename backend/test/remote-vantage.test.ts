import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureBaseline } from '../src/modules/campaigns/baseline.js';
import { waitForTargetAvailable } from '../src/modules/campaigns/recovery.js';
import { sampleRemoteProbe, validateProbeFreshness } from '../src/modules/probe/remote.js';
const remote = { agentUrl: 'http://probe.test/probe', token: 'fixture-token' };
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('remote vantage consistency', () => {
  it('takes baseline latency from the probe host, never from local RTT', async () => {
    const fetcher = vi.fn(async (_url, init) =>
      Response.json({
        ok: true,
        status: 200,
        latencyMs: 42,
        schema: 'ddostester.probe.response/v2',
        requestId: JSON.parse(init.body).requestId,
        observedAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const baseline = await captureBaseline('http://target.test/', undefined, 2, 0, 500, remote);
    expect(baseline.availabilityPct).toBe(100);
    expect(baseline.observation).toMatchObject({
      receivedSamples: 2,
      missingSamples: 0,
      complete: true,
    });
    expect(baseline.latencyMs.p95).toBe(42);
    for (const [url] of fetcher.mock.calls as unknown as [URL][])
      expect(url.hostname).toBe('probe.test');
  });
  it('does not fall back to target when the remote probe fails', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const baseline = await captureBaseline('http://target.test/', undefined, 1, 0, 500, remote);
    expect(baseline.availabilityPct).toBe(0);
    expect(baseline.observation).toMatchObject({
      receivedSamples: 0,
      missingSamples: 1,
      complete: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the remote vantage for recovery', async () => {
    const fetcher = vi.fn(async (_url, init) =>
      Response.json({
        ok: true,
        status: 200,
        latencyMs: 10,
        schema: 'ddostester.probe.response/v2',
        requestId: JSON.parse(init.body).requestId,
        observedAt: new Date().toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const local = vi.fn();
    expect(
      (await waitForTargetAvailable('http://target.test/', { remote, needed: 1, fetchImpl: local }))
        .available,
    ).toBe(true);
    expect(local).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects non-finite and negative remote latency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        Response.json({
          ok: true,
          status: 200,
          latencyMs: -1,
          schema: 'ddostester.probe.response/v2',
          requestId: JSON.parse(init.body).requestId,
          observedAt: new Date().toISOString(),
        }),
      ),
    );
    await expect(
      sampleRemoteProbe(remote, 'http://target.test/', 500, new AbortController().signal),
    ).rejects.toThrow(/Invalid/);
  });
  it('does no I/O for an already aborted baseline', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await captureBaseline('http://target.test/', controller.signal, 3, 0, 500, remote)).samples,
    ).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('rejects replay, old observations, future probe clocks and stale diagnostics', () => {
  const sentAt = Date.parse('2026-10-13T21:00:00.000Z');
  const challenge = { requestId: 'a'.repeat(32), sentAt };
  const response = {
    schema: 'ddostester.probe.response/v2',
    requestId: challenge.requestId,
    observedAt: new Date(sentAt + 100).toISOString(),
  };
  expect(() => validateProbeFreshness(response, challenge, sentAt + 200)).not.toThrow();
  for (const invalid of [
    { ...response, requestId: 'b'.repeat(32) },
    { ...response, observedAt: new Date(sentAt - 2001).toISOString() },
    { ...response, observedAt: new Date(sentAt + 2201).toISOString() },
    { ...response, quality: { sampledAt: new Date(sentAt - 2001).toISOString() } },
    { ...response, schema: 'legacy' },
  ])
    expect(() => validateProbeFreshness(invalid, challenge, sentAt + 200)).toThrow('freshness');
  expect(() => validateProbeFreshness(response, challenge, sentAt - 1)).toThrow('freshness');
});
it('rejects legacy transport responses without silently probing the target', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true, status: 200, latencyMs: 1 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    sampleRemoteProbe(remote, 'http://target.test/', 500, new AbortController().signal),
  ).rejects.toThrow('freshness');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects a previously valid response when replayed for the next request', async () => {
  let recorded: Record<string, unknown> | undefined;
  const fetcher = vi.fn(async (_url, init) => {
    recorded ??= {
      ok: true,
      status: 200,
      latencyMs: 1,
      schema: 'ddostester.probe.response/v2',
      requestId: JSON.parse(init.body).requestId,
      observedAt: new Date().toISOString(),
    };
    return Response.json(recorded);
  });
  vi.stubGlobal('fetch', fetcher);
  const sample = () =>
    sampleRemoteProbe(remote, 'http://target.test/', 500, new AbortController().signal);
  expect((await sample()).ok).toBe(true);
  await expect(sample()).rejects.toThrow('freshness');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('retains baseline resource coverage and peaks without filling missing diagnostics', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      calls++;
      const observedAt = new Date().toISOString();
      return Response.json({
        ok: true,
        status: 200,
        latencyMs: 10,
        schema: 'ddostester.probe.response/v2',
        requestId: JSON.parse(init.body).requestId,
        observedAt,
        ...(calls === 1
          ? {
              quality: {
                schema: 'ddostester.probe.quality/v1',
                scope: 'process-during-measurement',
                elapsedMs: 100,
                cpuUserUsec: 1,
                cpuSystemUsec: 2,
                rssBytes: 1000,
                eventLoopDelayMaxMs: null,
                cgroupThrottledUsecDelta: 20000,
                sampledAt: observedAt,
                recentEventLoop: {
                  scope: 'process-recent-window',
                  windowMs: 1000,
                  samples: 40,
                  maxMs: 175,
                },
              },
            }
          : {}),
      });
    }),
  );
  const baseline = await captureBaseline('http://target.test/', undefined, 2, 0, 500, remote);
  expect(baseline.observation?.complete).toBe(true);
  expect(baseline.quality).toMatchObject({
    measuredSamples: 1,
    totalSamples: 2,
    eventLoopMeasuredSamples: 1,
    peakEventLoopDelayMs: null,
    peakRecentEventLoopDelayMs: 175,
    peakThrottledFraction: 0.2,
    latest: { rssBytes: 1000 },
  });
});

it('does not mistake reachable recovery for verified recovery without diagnostics', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json({
        ok: true,
        status: 200,
        latencyMs: 10,
        schema: 'ddostester.probe.response/v2',
        requestId: JSON.parse(init.body).requestId,
        observedAt: new Date().toISOString(),
      }),
    ),
  );
  const result = await waitForTargetAvailable('http://target.test/', {
    remote,
    needed: 1,
    maxWaitMs: 200,
  });
  expect(result.available).toBe(true);
  expect(result.verified).toBe(false);
  expect(result.observation?.complete).toBe(true);
  expect(result.quality?.measuredSamples).toBe(0);
});
it('preserves verified recovery diagnostics from the independent probe', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const observedAt = new Date().toISOString();
      return Response.json({
        ok: true,
        status: 200,
        latencyMs: 10,
        schema: 'ddostester.probe.response/v2',
        requestId: JSON.parse(init.body).requestId,
        observedAt,
        quality: {
          schema: 'ddostester.probe.quality/v1',
          scope: 'process-during-measurement',
          elapsedMs: 100,
          cpuUserUsec: 1,
          cpuSystemUsec: 2,
          rssBytes: 1000,
          eventLoopDelayMaxMs: 20,
          cgroupThrottledUsecDelta: 0,
          sampledAt: observedAt,
        },
      });
    }),
  );
  const result = await waitForTargetAvailable('http://target.test/', {
    remote,
    needed: 1,
    maxWaitMs: 200,
  });
  expect(result.available).toBe(true);
  expect(result.verified).toBe(true);
  expect(result.quality).toMatchObject({
    measuredSamples: 1,
    totalSamples: 1,
    peakEventLoopDelayMs: 20,
    peakThrottledFraction: 0,
    latest: { rssBytes: 1000 },
  });
});
