import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import { renderCampaignReportHtml } from '../src/modules/reports/report.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { BuiltinHttpAgent } from '../src/agents/builtin.js';
import type { AttackAgent } from '../src/agents/types.js';

describe('executeCampaign — run time-series', () => {
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

  it('captures a per-second timeline persisted with the run', async () => {
    const campaign = {
      id: 'test-run',
      name: 'timeline',
      target: `${base}/`,
      probeUrl: `${base}/`,
      vector: 'http-get',
      maxRps: 20,
      concurrency: 2,
      maxDurationSec: 2,
      createdBy: 'e@wedos',
      authorized: true,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    } as Campaign;

    const run = await executeCampaign(campaign, ['127.0.0.1'], new KillSwitch());

    expect(Array.isArray(run.timeline)).toBe(true);
    expect(run.timeline!.length).toBeGreaterThan(0);

    // EPIC B2: a nominal baseline is captured before the ramp, with deltas.
    expect(run.baseline).toBeDefined();
    expect(run.baseline!.availabilityPct).toBe(100);
    expect(run.baselineDelta).toBeDefined();
    const s = run.timeline![0];
    expect(s.t).toBeGreaterThanOrEqual(0);
    expect(s.sampleUnit).toBe('requests');
    expect(s.probeSamples).toBeGreaterThan(0);
    expect(s.probeP95).toBeGreaterThanOrEqual(0);
    expect(typeof s.generatorObserved).toBe('boolean');
    expect(s.availPct).toBeGreaterThanOrEqual(0);
    expect(s.availPct).toBeLessThanOrEqual(100);
    // Samples are ordered by elapsed time.
    const ts = run.timeline!.map((x) => x.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  }, 15000);

  const makeCampaign = (): Campaign =>
    ({
      id: 'test-detail',
      name: 'detail',
      target: `${base}/`,
      probeUrl: `${base}/`,
      vector: 'http-get',
      maxRps: 20,
      concurrency: 2,
      maxDurationSec: 2,
      createdBy: 'e@wedos',
      authorized: true,
      status: 'APPROVED',
      createdAt: new Date().toISOString(),
    }) as Campaign;

  it('prepares before the load timer, refreshes baseline and disposes the prepared run', async () => {
    const events: string[] = [];
    const kill = new KillSwitch();
    const agent: AttackAgent = new BuiltinHttpAgent();
    agent.prepare = async (config, hosts, signal) => {
      events.push('prepare');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(signal?.aborted).toBe(false);
      return {
        run: async () => {
          events.push('load');
          return new BuiltinHttpAgent().run(config, hosts, signal);
        },
        dispose: async () => {
          events.push('dispose');
        },
      };
    };
    await executeCampaign(
      { ...makeCampaign(), maxDurationSec: 1 },
      ['127.0.0.1'],
      kill,
      undefined,
      agent,
      undefined,
      async () => {
        events.push('baseline');
        return { samples: 3, availabilityPct: 100, latencyMs: { p50: 1, p95: 1 } };
      },
    );
    expect(events).toEqual(['baseline', 'prepare', 'baseline', 'load', 'dispose']);
  }, 10000);

  it('disposes without launching when cancelled after runtime preparation', async () => {
    const kill = new KillSwitch();
    let baselineCalls = 0,
      disposed = false,
      launched = false;
    const agent: AttackAgent = new BuiltinHttpAgent();
    agent.prepare = async () => ({
      run: async () => {
        launched = true;
        throw new Error('Unexpected launch');
      },
      dispose: async () => {
        disposed = true;
      },
    });
    await expect(
      executeCampaign(
        makeCampaign(),
        ['127.0.0.1'],
        kill,
        undefined,
        agent,
        undefined,
        async () => {
          if (++baselineCalls === 2) kill.trigger('KILLED_MANUAL');
          return { samples: 3, availabilityPct: 100, latencyMs: { p50: 1, p95: 1 } };
        },
      ),
    ).rejects.toThrow('cancelled during preparation');
    expect(disposed).toBe(true);
    expect(launched).toBe(false);
  });

  it('captures the IoT profile in the actual generator result independently of campaign changes', async () => {
    const campaign = createCampaign(
      {
        ...makeCampaign(),
        agent: 'builtin',
        vector: 'http-post',
        iotProfile: { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 7 },
      },
      ['127.0.0.1'],
    );
    campaign.status = 'APPROVED';
    const expectedFlow = structuredClone(campaign.flow);
    const run = await executeCampaign(campaign, ['127.0.0.1'], new KillSwitch());
    campaign.iotProfile!.seed = 99;
    campaign.flow![1].body = 'changed after run';
    expect(run.generator.config.iotProfile).toEqual({
      id: 'sensor-heartbeat/v1',
      seed: 42,
      deviceIndex: 7,
    });
    expect(run.generator.config.execution).toMatchObject({
      engine: 'builtin-http',
      runtime: process.version,
      probeUrl: campaign.probeUrl,
      probeVantage: 'local',
    });
    expect(run.generator.config.flow).toEqual(expectedFlow);
  }, 15_000);

  it('does not emit fake live request metrics when an engine has no progress stream', async () => {
    const { metrics } = await import('../src/modules/metrics/runtime.js');
    const agent = new BuiltinHttpAgent();
    agent.run = (config, hosts, signal) => new BuiltinHttpAgent().run(config, hosts, signal);
    let checked = false;
    const observed = await executeCampaign(
      makeCampaign(),
      ['127.0.0.1'],
      new KillSwitch(),
      (p) => {
        if (!p.probe?.samples) return;
        checked = true;
        expect(p.generatorObserved).toBe(false);
        expect(metrics.render()).not.toMatch(/shieldtest_run_live_offered_rps\{/);
      },
      agent,
    );
    expect(checked).toBe(true);
    expect(observed.timeline?.every((t) => t.generatorObserved === false)).toBe(true);
    expect(observed.timeline?.some((t) => t.probeP95 !== undefined)).toBe(true);
  }, 15000);

  it('retires the live per-run Prometheus gauges when the run ends (no stale flat line)', async () => {
    const { metrics } = await import('../src/modules/metrics/runtime.js');
    await executeCampaign(makeCampaign(), ['127.0.0.1'], new KillSwitch());
    // The live gauges were set during the run and cleared in the finally, so a
    // finished run leaves no lingering series in the scrape.
    const out = metrics.render();
    expect(out).not.toContain('shieldtest_run_live_offered_rps');
    expect(out).not.toContain('shieldtest_run_live_probe_avail_pct');
  }, 15000);

  it('a clean completion carries no statusDetail', async () => {
    const run = await executeCampaign(makeCampaign(), ['127.0.0.1'], new KillSwitch());
    expect(run.status).toBe('COMPLETED');
    expect(run.statusDetail).toBeUndefined();
  }, 15000);

  it('an auto-kill explains why (target unavailable + measured availability)', async () => {
    const kill = new KillSwitch();
    kill.trigger('KILLED_AUTO'); // simulate the probe's level-1 trip
    const run = await executeCampaign(makeCampaign(), ['127.0.0.1'], kill);
    expect(run.status).toBe('KILLED_AUTO');
    expect(run.statusDetail).toMatch(/Auto-killed/);
    expect(run.statusDetail).toMatch(/unavailable/);
    expect(run.statusDetail).toMatch(/availability/);
  }, 15000);

  it('a manual kill is explained too', async () => {
    const kill = new KillSwitch();
    kill.trigger('KILLED_MANUAL');
    const run = await executeCampaign(makeCampaign(), ['127.0.0.1'], kill);
    expect(run.status).toBe('KILLED_MANUAL');
    expect(run.statusDetail).toMatch(/Manually stopped/);
  }, 15000);

  it('the HTML report carries the kill explanation (not just the bare status)', async () => {
    const campaign = makeCampaign();
    const kill = new KillSwitch();
    kill.trigger('KILLED_AUTO');
    const run = await executeCampaign(campaign, ['127.0.0.1'], kill);
    const html = renderCampaignReportHtml(campaign, run);
    // The report must explain *why* the run ended, mirroring the UI drawer.
    expect(html).toContain('KILLED AUTO'); // status pill (redesigned report)
    expect(html).toContain(run.statusDetail!);
    expect(html).toMatch(/Auto-killed/);
  }, 15000);

  it('a clean completion adds no kill callout to the report', async () => {
    const campaign = makeCampaign();
    const run = await executeCampaign(campaign, ['127.0.0.1'], new KillSwitch());
    const html = renderCampaignReportHtml(campaign, run);
    expect(run.status).toBe('COMPLETED');
    expect(html).not.toContain('class="kill"');
  }, 15000);

  it('a measured protection source yields real TTD/TTM and a non-estimated WRS', async () => {
    const protection = {
      configured: true,
      async measure() {
        return { detectionTimeSec: 4, mitigationTimeSec: 11, source: 'scrubbing' };
      },
    };
    const campaign = makeCampaign();
    const run = await executeCampaign(
      campaign,
      ['127.0.0.1'],
      new KillSwitch(),
      undefined,
      undefined,
      protection,
    );
    expect(run.wrs.estimated).toBe(false);
    expect(run.protection).toEqual({
      source: 'scrubbing',
      detectionTimeSec: 4,
      mitigationTimeSec: 11,
    });
    const html = renderCampaignReportHtml(campaign, run);
    expect(html).toContain('Protection (measured)');
    expect(html).toContain('Time-to-detect');
    expect(html).toContain('4s'); // TTD
    expect(html).toContain('11s'); // TTM
  }, 15000);

  // ── Closed-loop rate calibration (GEN-1) ──────────────────────────────────────
  // A fake agent lets us force under-delivery on the calibration burst and assert
  // the graded run is then offered at the calibrated (lowered) rate.
  const fakeResult = (maxRps: number, actualRps: number) => ({
    id: `res-${Math.random().toString(36).slice(2)}`,
    config: {} as never,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalRequests: actualRps * 2,
    successful: actualRps * 2,
    failed: 0,
    statusCounts: {},
    latencyMs: { min: 1, max: 5, mean: 2, p50: 2, p95: 4, p99: 5 },
    actualRps,
    errors: {},
    _requestedMaxRps: maxRps,
  });

  /** A recording agent: burst (durationSec 12) under-delivers; graded run echoes its offered rate. */
  function recordingAgent(burstRps: number) {
    const calls: number[] = [];
    const agent = {
      name: 'fake',
      multiPhase: true,
      flowCapable: false,
      endpointCapable: true,
      correlationCapable: false,
      description: 'fake',
      available: async () => true,
      run: async (config: { maxRps: number; durationSec?: number }) => {
        calls.push(config.maxRps);
        // The calibration burst runs at CALIBRATION_SEC (12s); it under-delivers.
        const isBurst = config.durationSec === 12;
        return fakeResult(config.maxRps, isBurst ? burstRps : config.maxRps);
      },
    };
    return { agent, calls };
  }

  it('calibrates the graded rate down to the deliverable ceiling when the burst under-delivers', async () => {
    const { agent, calls } = recordingAgent(120); // burst delivers only 120 of 800
    const campaign = {
      ...makeCampaign(),
      id: 'calib-down',
      maxRps: 800,
      maxDurationSec: 2,
      calibrate: true,
    } as Campaign;
    const run = await executeCampaign(
      campaign,
      ['127.0.0.1'],
      new KillSwitch(),
      undefined,
      agent as never,
    );
    // Two agent.run calls: the calibration burst (at the requested peak 800) then
    // the graded run (at the calibrated rate).
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(800); // burst measured at the requested peak
    expect(run.calibration).toBeDefined();
    expect(run.calibration!.calibrated).toBe(true);
    expect(run.calibration!.requestedRps).toBe(800);
    expect(run.calibration!.deliveredRps).toBe(120);
    // The graded run was offered at the calibrated rate (floor(120 × 0.95) = 114).
    expect(run.calibration!.appliedRps).toBe(114);
    expect(calls[1]).toBe(114);
    expect(calls[1]).toBeLessThan(800);
  }, 20000);

  it('calibration never rounds a fractional campaign up to one request per second', async () => {
    const { agent, calls } = recordingAgent(0.2);
    const run = await executeCampaign(
      { ...makeCampaign(), maxRps: 0.5, maxDurationSec: 1, calibrate: true },
      ['127.0.0.1'],
      new KillSwitch(),
      undefined,
      agent as never,
      undefined,
      async () => ({ samples: 3, availabilityPct: 100, latencyMs: { p50: 1, p95: 1 } }),
    );
    expect(calls[0]).toBe(0.5);
    expect(calls[1]).toBeCloseTo(0.19);
    expect(run.calibration?.requestedRps).toBe(0.5);
    expect(run.calibration?.appliedRps).toBeCloseTo(0.19);
  }, 10000);

  it('keeps the requested rate (single run, no calibration record) when calibrate is off', async () => {
    const { agent, calls } = recordingAgent(120);
    const campaign = { ...makeCampaign(), id: 'calib-off', maxRps: 800 } as Campaign;
    const run = await executeCampaign(
      campaign,
      ['127.0.0.1'],
      new KillSwitch(),
      undefined,
      agent as never,
    );
    expect(calls.length).toBe(1); // no pre-flight burst
    expect(calls[0]).toBe(800); // graded at the requested rate
    expect(run.calibration).toBeUndefined();
  }, 15000);

  it('keeps the requested rate when the burst confirms it is deliverable', async () => {
    const { agent, calls } = recordingAgent(780); // 780/800 = 97.5% ≥ 90% → keep
    const campaign = {
      ...makeCampaign(),
      id: 'calib-keep',
      maxRps: 800,
      calibrate: true,
    } as Campaign;
    const run = await executeCampaign(
      campaign,
      ['127.0.0.1'],
      new KillSwitch(),
      undefined,
      agent as never,
    );
    expect(calls.length).toBe(2); // burst still runs
    expect(run.calibration!.calibrated).toBe(false);
    expect(calls[1]).toBe(800); // graded unchanged at the requested rate
  }, 20000);
});
