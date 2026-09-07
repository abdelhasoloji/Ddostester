import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCampaign } from '../src/modules/campaigns/runner.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import { renderCampaignReportHtml } from '../src/modules/reports/report.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

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
    expect(html).toContain('KILLED_AUTO');
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
});
