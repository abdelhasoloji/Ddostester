/** Phase of a bounded scenario: a rate held for a duration. */
export interface ScenarioPhase {
  maxRps: number;
  durationSec: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/**
 * One step of a bounded request flow (L7 user journey): a single HTTP request
 * to an allowlisted host, optionally followed by a think-time pause. Flows make
 * the load realistic (login → action → logout) but never bypass the caps: the
 * global `maxRps` still bounds the TOTAL request rate, and think-time only
 * lowers the load. It is not a slow-loris style vector — the pause is between
 * complete requests, never mid-request.
 */
export interface RequestStep {
  method: HttpMethod;
  /** Full URL; its host must be in the allowlist (validated like `url`). */
  url: string;
  body?: string;
  /** Per-step headers (merged over the campaign headers); support `{{vars}}`. */
  headers?: Record<string, string>;
  /** Pause after this step, in ms (0..MAX_THINK_MS). Only reduces load. */
  thinkMs?: number;
  /** Optional label for reports. */
  name?: string;
  /**
   * Correlation: extract a value from this step's response into a variable that
   * later steps can reference via `{{name}}` (realistic authenticated journeys).
   */
  extract?: RequestExtract;
}

/** Extraction rule: pull `name` from the response body (JSON path / regex) or a header. */
export interface RequestExtract {
  name: string;
  from: 'json' | 'header' | 'regex';
  /** JSON dot-path, header name, or regex (first capture group, else full match). */
  expr: string;
}

/** Bounds for request flows (defense in depth). */
export const MAX_FLOW_STEPS = 20;
export const MAX_THINK_MS = 30_000;

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
   * Optional bounded request flow (L7 journey). When present, each virtual user
   * iterates these steps in order instead of hitting `url` once. Every step's
   * host is allowlisted and the global `maxRps` still caps the total request
   * rate (engines that count iterations divide the arrival rate by the number
   * of steps). Absent = single request to `url`.
   */
  flow?: RequestStep[];
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
