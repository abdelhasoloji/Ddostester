import type { LoadTestConfig, LoadTestResult } from '../../engine/types.js';
import type { LatencyHistogram } from '../../engine/stats.js';
import { mergeHistograms, percentileUpperBound } from './aggregate.js';
export interface FleetShardEvidence {
  agentId: string;
  /** Site that emitted this shard (provenance; 'local' for single-site history). */
  site?: string;
  state: string;
  attemptId: string;
  leaseUntil: number;
  assignmentHash?: string;
  budget?: { maxRps: number; concurrency: number; durationSec: number };
  result?: Record<string, unknown>;
}
export function fleetCounterCoverage(shards: FleetShardEvidence[]) {
  return {
    reportedAgents: shards.filter((shard) => shard.result?.generator).length,
    expectedAgents: shards.length,
    scope: 'received-final-results-only' as const,
  };
}
/** Start timestamps diagnose startup cost, not first target arrival or a corrected global rate. */
export function fleetStartupEvidence(
  startedAt: string,
  finishedAt: string,
  shards: FleetShardEvidence[],
) {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  const parentValid = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const agents = shards.map((shard) => {
    const result = shard.result?.generator as Partial<LoadTestResult> | undefined;
    const agentStart = typeof result?.startedAt === 'string' ? Date.parse(result.startedAt) : NaN;
    const agentEnd = typeof result?.finishedAt === 'string' ? Date.parse(result.finishedAt) : NaN;
    const valid =
      parentValid &&
      Number.isFinite(agentStart) &&
      Number.isFinite(agentEnd) &&
      agentStart >= start &&
      agentEnd >= agentStart &&
      agentEnd <= end;
    return { agentId: shard.agentId, generatorStartDelayMs: valid ? agentStart - start : null };
  });
  const delays = agents.flatMap((agent) =>
    agent.generatorStartDelayMs === null ? [] : [agent.generatorStartDelayMs],
  );
  return {
    schema: 'ddostester.fleet.startup/v1' as const,
    scope: 'generator-timestamps-relative-to-parent' as const,
    reportedAgents: delays.length,
    expectedAgents: shards.length,
    firstGeneratorStartDelayMs: delays.length ? Math.min(...delays) : null,
    lastGeneratorStartDelayMs: delays.length ? Math.max(...delays) : null,
    agents,
  };
}

/** Accept only coherent final counters; unavailable shards remain explicit evidence gaps. */
export function summarizeFleet(
  runId: string,
  config: LoadTestConfig,
  startedAt: string,
  shards: FleetShardEvidence[],
): LoadTestResult {
  const results: LoadTestResult[] = [];
  for (const shard of shards) {
    if (!shard.result?.generator) continue;
    const g = shard.result.generator as LoadTestResult;
    if (
      ![g.totalRequests, g.successful, g.failed].every((x) => Number.isSafeInteger(x) && x >= 0) ||
      g.successful + g.failed > g.totalRequests ||
      !g.latencyHistogram ||
      !g.latencyMs ||
      ![g.latencyMs.min, g.latencyMs.max].every((x) => Number.isFinite(x) && x >= 0) ||
      g.latencyMs.max < g.latencyMs.min
    )
      throw new Error('Invalid shard measurement');
    mergeHistograms([g.latencyHistogram]);
    if (g.latencyHistogram.count > g.totalRequests)
      throw new Error('Incomplete shard latency observations');
    results.push(g);
  }
  const histogram = mergeHistograms(results.map((r) => r.latencyHistogram as LatencyHistogram));
  const finishedAt = new Date().toISOString();
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid fleet clock');
  const elapsed = Math.max(0.001, elapsedMs / 1000);
  const sum = (key: 'totalRequests' | 'successful' | 'failed') =>
    results.reduce((n, r) => n + r[key], 0);
  const max = results.length ? Math.max(...results.map((r) => r.latencyMs.max)) : 0;
  const statusCounts: Record<string, number> = Object.create(null);
  const errors: Record<string, number> = Object.create(null);
  for (const result of results)
    for (const [counts, target] of [
      [result.statusCounts, statusCounts],
      [result.errors, errors],
    ] as const)
      for (const [key, value] of Object.entries(counts)) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid shard counters');
        target[key] = (target[key] ?? 0) + value;
      }
  const complete =
    shards.length > 0 &&
    shards.length === results.length &&
    shards.every((s) => s.state === 'SUCCEEDED') &&
    results.every(
      (r) =>
        !r.hardStopped &&
        (r.latencyHistogram?.count ?? 0) + Object.values(r.errors).reduce((a, b) => a + b, 0) ===
          r.totalRequests &&
        r.successful + r.failed === r.totalRequests,
    );
  return {
    id: runId,
    config,
    startedAt,
    finishedAt,
    totalRequests: sum('totalRequests'),
    successful: sum('successful'),
    failed: sum('failed'),
    statusCounts,
    errors,
    actualRps: sum('totalRequests') / elapsed,
    latencyHistogram: histogram,
    latencyPolicy: 'histogram-upper-bound-v1',
    latencyMs: {
      min: results.length ? Math.min(...results.map((r) => r.latencyMs.min)) : 0,
      max,
      mean: histogram.count ? histogram.sumMs / histogram.count : 0,
      p50: percentileUpperBound(histogram, 50) ?? max,
      p95: percentileUpperBound(histogram, 95) ?? max,
      p99: percentileUpperBound(histogram, 99) ?? max,
    },
    hardStopped: results.some((result) => result.hardStopped),
    fleet: {
      measurementComplete: complete,
      counterCoverage: fleetCounterCoverage(shards),
      startup: fleetStartupEvidence(startedAt, finishedAt, shards),
      shards,
    },
  };
}
