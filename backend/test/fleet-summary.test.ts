import { describe, expect, it } from 'vitest';
import {
  summarizeFleet,
  fleetStartupEvidence,
  type FleetShardEvidence,
} from '../src/modules/fleet/summary.js';
import { latencyHistogram } from '../src/engine/stats.js';
import { LATENCY_BUCKETS_MS } from '../src/config/limits.js';
const config = {
  url: 'http://target.test/',
  authorized: true,
  maxRps: 15,
  concurrency: 6,
  durationSec: 30,
};
const shard = (agentId: string, latencies: number[]): FleetShardEvidence => ({
  agentId,
  state: 'SUCCEEDED',
  attemptId: agentId,
  leaseUntil: Date.now() + 6000,
  result: {
    generator: {
      totalRequests: latencies.length,
      successful: latencies.length,
      failed: 0,
      latencyMs: { min: Math.min(...latencies), max: Math.max(...latencies) },
      latencyHistogram: latencyHistogram(latencies, LATENCY_BUCKETS_MS),
      statusCounts: { '2xx': latencies.length },
      errors: {},
    },
  },
});
describe('fleet evidence summary', () => {
  it('records counter coverage without inventing a lost agent result', () => {
    const result = summarizeFleet('run', config, new Date(Date.now() - 1000).toISOString(), [
      shard('one', [10, 20]),
      { agentId: 'two', state: 'LOST', attemptId: 'a', leaseUntil: 0 },
    ]);
    expect(result.totalRequests).toBe(2);
    expect(result.fleet?.counterCoverage).toEqual({
      reportedAgents: 1,
      expectedAgents: 2,
      scope: 'received-final-results-only',
    });
    expect(result.fleet?.measurementComplete).toBe(false);
  });
  it('treats an empty evidence set as incomplete', () => {
    expect(
      summarizeFleet('run', config, new Date().toISOString(), []).fleet?.measurementComplete,
    ).toBe(false);
  });
  it('aggregates observation counts and flags bucket-based percentiles', () => {
    const result = summarizeFleet('run', config, new Date(Date.now() - 1000).toISOString(), [
      shard('one', [10, 10]),
      shard('two', [100]),
    ]);
    expect(result.totalRequests).toBe(3);
    expect(result.successful).toBe(3);
    expect(result.latencyMs.p95).toBe(100);
    expect(result.latencyPolicy).toBe('histogram-upper-bound-v1');
    expect(result.fleet?.measurementComplete).toBe(true);
  });
  it('never turns an absent shard into complete evidence', () => {
    const result = summarizeFleet('run', config, new Date().toISOString(), [
      shard('one', [10]),
      { agentId: 'two', state: 'LOST', attemptId: 'two', leaseUntil: 0 },
    ]);
    expect(result.hardStopped).toBe(false);
    expect(result.fleet?.measurementComplete).toBe(false);
    expect(result.totalRequests).toBe(1);
  });
  it('preserves partial counters while marking missing latency observations', () => {
    const x = shard('one', [10]);
    const g = x.result!.generator as { totalRequests: number; hardStopped: boolean };
    g.totalRequests = 2;
    g.hardStopped = true;
    const result = summarizeFleet('run', config, new Date().toISOString(), [x]);
    expect(result.totalRequests).toBe(2);
    expect(result.latencyHistogram?.count).toBe(1);
    expect(result.fleet?.measurementComplete).toBe(false);
  });
});

it('reports startup windows without correcting global throughput or inventing missing clocks', () => {
  const one = shard('one', [10]);
  Object.assign(one.result!.generator as object, {
    startedAt: '2026-10-13T00:00:10.000Z',
    finishedAt: '2026-10-13T00:00:28.000Z',
  });
  const two = shard('two', [10]);
  Object.assign(two.result!.generator as object, {
    startedAt: '2026-10-12T23:59:59.000Z',
    finishedAt: '2026-10-13T00:00:28.000Z',
  });
  const evidence = fleetStartupEvidence('2026-10-13T00:00:00.000Z', '2026-10-13T00:00:30.000Z', [
    one,
    two,
    shard('three', [10]),
  ]);
  expect(evidence.reportedAgents).toBe(1);
  expect(evidence.expectedAgents).toBe(3);
  expect(evidence.firstGeneratorStartDelayMs).toBe(10000);
  expect(evidence.agents[1].generatorStartDelayMs).toBeNull();
  expect(evidence.agents[2].generatorStartDelayMs).toBeNull();
});

it('rejects a backwards parent clock instead of generating an inflated global rate', () => {
  expect(() =>
    summarizeFleet('run', config, '2099-01-01T00:00:00.000Z', [shard('one', [10])]),
  ).toThrow('Invalid fleet clock');
});
