import { describe, it, expect, vi } from 'vitest';
import { createProbeCollectorPort, expectedStatus } from '../src/modules/drs/probe-collector.js';
import type { DrsPlan } from '../src/modules/drs/model.js';

const plan = {
  services: [
    {
      id: 'service-1',
      url: 'http://lab/',
      protocol: 'HTTP',
      journey: 'GET /',
      functionalAssertion: 'status 200 and body contains ok',
      successThreshold: 0.99,
    },
  ],
  sources: [
    { id: 'generator', role: 'generator' },
    { id: 'user', role: 'user' },
  ],
  architecture: { injectionPoint: 'http://lab/' },
  budgets: { maxRps: 50, concurrency: 10, maxAgents: 1, maxDurationSec: 5 },
  recoveryTimeoutSec: 2,
  baselineMinSec: 0.05,
} as unknown as DrsPlan;

const fetchOk = () =>
  vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }) as unknown as Response);
const fetchDown = () =>
  vi.fn(async () => {
    throw new Error('connect ECONNREFUSED');
  });

describe('functional assertion parsing', () => {
  it('reads a named status and refuses to guess without one', () => {
    expect(expectedStatus('status 200 and body contains ok')).toBe(200);
    expect(expectedStatus('the page still works')).toBeNull();
  });
});

describe('probe collector', () => {
  it('refuses capacity when the probe is not healthy', async () => {
    const port = createProbeCollectorPort({ probeUrl: 'http://lab/', fetchImpl: fetchDown() });
    await expect(port.capacity(plan)).resolves.toMatchObject({ ready: false });
  });

  it('is ready with gaps named, and seals evidence that carries them', async () => {
    const port = createProbeCollectorPort({ probeUrl: 'http://lab/', fetchImpl: fetchOk() });
    const capacity = await port.capacity(plan);
    expect(capacity.ready).toBe(true);
    expect(capacity.reason).toContain('no entry witness');
    expect(capacity.reason).toContain('no origin witness');

    const signal = new AbortController();
    const baseline = await port.baseline(plan, signal.signal);
    expect(baseline.healthy).toBe(true);

    const exposure = new AbortController();
    setTimeout(() => exposure.abort(), 30);
    await port.observe(['v1'], plan, exposure.signal);
    await port.seal(['v1'], plan).then((evidence) => {
      expect(evidence[0].points.map((p) => p.sourceId)).toEqual(['generator', 'user']);
      expect(evidence[0].unrepresented_dimensions.join(' ')).toContain('entry instrumentation');
      expect(evidence[0].legitimate_transaction_success[0].assertionEvaluated).toBe(true);
      expect(evidence[0].latency_during_test.samplesMs.length).toBeGreaterThan(0);
    });
  });

  it('records an outage interval when the service fails during the exposure', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First sample healthy, then the origin goes down.
      if (call < 2) return { ok: true, status: 200, text: async () => 'ok' } as unknown as Response;
      throw new Error('ECONNRESET');
    });
    const port = createProbeCollectorPort({ probeUrl: 'http://lab/', fetchImpl });
    const signal = new AbortController();
    await port.baseline(plan, signal.signal);
    const exposure = new AbortController();
    setTimeout(() => exposure.abort(), 40);
    await port.observe(['v1'], plan, exposure.signal);
    const evidence = await port.seal(['v1'], plan);
    expect(evidence[0].outage_intervals.length).toBeGreaterThanOrEqual(1);
  });
});

describe('entry and origin witnesses', () => {
  // Each telemetry URL reports a cumulative counter; the second read is the exposure end.
  const witnessFetch = () => {
    const reads: Record<string, number> = {};
    return vi.fn(async (url: string) => {
      if (url.includes('/telemetry')) {
        reads[url] = (reads[url] ?? 0) + 1;
        const requests = reads[url] === 1 ? 0 : 500;
        return {
          ok: true,
          status: 200,
          json: async () => ({ requests, errors: 0 }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => 'ok' } as unknown as Response;
    });
  };

  it('names no gap and seals entry and origin points when witnesses answer', async () => {
    const port = createProbeCollectorPort({
      probeUrl: 'http://lab/',
      entryWitnessUrl: 'http://edge/telemetry',
      originWitnessUrl: 'http://origin/telemetry',
      fetchImpl: witnessFetch() as unknown as typeof fetch,
    });
    const capacity = await port.capacity(plan);
    expect(capacity.ready).toBe(true);
    expect(capacity.reason).not.toContain('no entry witness');
    expect(capacity.reason).not.toContain('no origin witness');

    const baseline = await port.baseline(plan, new AbortController().signal);
    expect(baseline.healthy).toBe(true);

    const exposure = new AbortController();
    setTimeout(() => exposure.abort(), 30);
    await port.observe(['v1'], plan, exposure.signal);
    const [evidence] = await port.seal(['v1'], plan);

    expect(evidence.points.map((p) => p.sourceId)).toEqual([
      'entry',
      'origin',
      'generator',
      'user',
    ]);
    expect(evidence.points.find((p) => p.sourceId === 'entry')?.load?.value).toBeGreaterThan(0);
    expect(evidence.unrepresented_dimensions.some((d) => d.startsWith('entry'))).toBe(false);
    expect(evidence.unrepresented_dimensions.some((d) => d.startsWith('origin'))).toBe(false);
  });
});
