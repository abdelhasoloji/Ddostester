import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';

/** Metadata every external-engine parser stamps onto a LoadTestResult. */
export interface ResultMeta {
  id: string;
  config: LoadTestConfig;
  startedAt: string;
  finishedAt: string;
}

/** A zero-valued result (tool produced no data, or an empty phase). */
export function emptyResult(meta: ResultMeta): LoadTestResult {
  return {
    ...meta,
    totalRequests: 0,
    successful: 0,
    failed: 0,
    statusCounts: {},
    latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
    actualRps: 0,
    errors: {},
  };
}
