/** Phase of a bounded scenario: a rate held for a duration. */
export interface ScenarioPhase {
  maxRps: number;
  durationSec: number;
}

export interface LoadTestConfig {
  /** Full target URL (e.g. http://localhost:3000/health). */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Number of concurrent requests (virtual workers). */
  concurrency: number;
  /** Test duration in seconds (single phase; ignored if `phases` is provided). */
  durationSec: number;
  /**
   * Requests-per-second cap (mandatory): a safeguard against accidentally
   * saturating an infrastructure. Must be > 0. In multi-phase mode, it is the
   * maximum rate across the phases.
   */
  maxRps: number;
  /**
   * Optional bounded scenario (GEN-03): sequential phases (ramp-up, waves…).
   * Each phase remains subject to the same caps. Absent = single phase.
   */
  phases?: ScenarioPhase[];
  /**
   * Responsibility acknowledgement: the user confirms the target belongs to
   * them or that they hold a written authorization. Without this flag, the test
   * is refused.
   */
  authorized: boolean;
  timeoutMs?: number;
}

export interface LoadTestResult {
  id: string;
  config: LoadTestConfig;
  startedAt: string;
  finishedAt: string;
  totalRequests: number;
  successful: number;
  failed: number;
  statusCounts: Record<string, number>;
  latencyMs: { min: number; max: number; mean: number; p50: number; p95: number; p99: number };
  actualRps: number;
  errors: Record<string, number>;
}
