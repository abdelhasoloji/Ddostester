import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
} from '../src/modules/drs/workflow.js';
import { orchestrateDrs } from '../src/modules/drs/orchestrator.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
function setup(mode: 'engine-validation' | 'synthetic-lab') {
  const c: Campaign = {
    id: randomUUID(),
    name: 'fixture',
    status: 'PENDING_APPROVAL',
    createdAt: new Date().toISOString(),
    createdBy: 'fixture',
    authorized: true,
    target: 'http://lab-target/',
    probeUrl: 'http://lab-target/',
    vector: 'http-get',
    agent: 'fleet',
    maxRps: 3,
    concurrency: 3,
    maxDurationSec: 20,
  };
  const r = currentRevision(createRevision(undefined, defaultPlan(c, mode), 'fixture'));
  freeze(r, c);
  const ports = {
    generator: {
      capacity: vi.fn().mockResolvedValue({ ready: false, reason: 'Unqualified generator' }),
      start: vi.fn(),
    },
    collector: {
      capacity: vi
        .fn()
        .mockResolvedValue({ ready: false, reason: 'Missing independent entry instrumentation' }),
      baseline: vi.fn(),
      observe: vi.fn(),
      recovery: vi.fn(),
      seal: vi.fn(),
    },
    signal: new AbortController().signal,
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
  return { r, ports };
}
it('executes a complete simulated lifecycle without calling physical ports', async () => {
  const { r, ports } = setup('engine-validation');
  const a = await orchestrateDrs(r, 'fixture', ports);
  expect(a.score).toBe(1);
  expect(r.state).toBe('FINAL_REPORT');
  expect(ports.generator.capacity).not.toHaveBeenCalled();
  expect(ports.collector.baseline).not.toHaveBeenCalled();
  expect(ports.generator.start).not.toHaveBeenCalled();
});
it('finalizes an indeterminate report when physical capacity is absent; no injection or baseline', async () => {
  const { r, ports } = setup('synthetic-lab');
  const a = await orchestrateDrs(r, 'fixture', ports);
  expect(a.score).toBeNull();
  expect(a.status).toBe('INDETERMINATE');
  expect(ports.generator.start).not.toHaveBeenCalled();
  expect(ports.collector.baseline).not.toHaveBeenCalled();
  expect(r.state).toBe('FINAL_REPORT');
});

it('stops bounded injection when independent observation fails and finalizes without a false success', async () => {
  const { r, ports } = setup('synthetic-lab');
  r.plan.excludedVectors = [
    {
      vectorId: 'drs-3.00.00-111001',
      reason: 'Unsupported physical vector; full denominator retained',
    },
  ];
  // Freeze the adjusted plan again before any observations.
  r.state = 'DRAFT';
  r.planHash = undefined;
  const c = {
    authorized: true,
    maxRps: 3,
    concurrency: 3,
    maxDurationSec: 20,
    target: 'http://lab-target/',
    probeUrl: 'http://lab-target/',
  } as Campaign;
  freeze(r, c);
  ports.generator.capacity.mockResolvedValue({ ready: true, reason: 'Bounded GET only' });
  ports.collector.capacity.mockResolvedValue({ ready: true, reason: 'Independent fixture' });
  ports.collector.baseline.mockResolvedValue({ healthy: true, stable: true, durationSec: 300 });
  const stop = vi.fn().mockResolvedValue({ confirmed: true, stoppedAt: new Date().toISOString() });
  ports.generator.start.mockResolvedValue({ stop });
  ports.collector.observe.mockRejectedValue(Error('Fixture telemetry interruption'));
  const a = await orchestrateDrs(r, 'fixture', ports);
  expect(stop).toHaveBeenCalledOnce();
  expect(a.score).toBeNull();
  expect(r.state).toBe('FINAL_REPORT');
  expect(ports.collector.recovery).not.toHaveBeenCalled();
});
it('does not inject when baseline is unhealthy or the standard requires unsupported physical vectors', async () => {
  for (const healthy of [false, true]) {
    const { r, ports } = setup('synthetic-lab');
    ports.generator.capacity.mockResolvedValue({ ready: true, reason: 'Port fixture' });
    ports.collector.capacity.mockResolvedValue({ ready: true, reason: 'Collector fixture' });
    ports.collector.baseline.mockResolvedValue({ healthy, stable: true, durationSec: 300 });
    await orchestrateDrs(r, 'fixture', ports);
    expect(ports.generator.start).not.toHaveBeenCalled();
    expect(r.state).toBe('FINAL_REPORT');
  }
});
