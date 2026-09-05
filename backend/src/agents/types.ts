import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';

/**
 * Load-agent contract (“bring-your-own-generator”). ShieldTest remains the
 * control plane (authorization, allowlist, caps, kill switch, probe, WRS,
 * audit); the agent only produces the load and reports metrics. An agent MUST
 * honour the bounded config (validateConfig) and the stop signal. No agent
 * provided here implements an attack vector: the built-in generator is bounded
 * HTTP; the k6 adapter delegates to an external load-testing tool, licensed and
 * operated by the team.
 */

/** Operational agent error (e.g. external tool unavailable) → 503. */
export class AgentError extends Error {}

export interface AttackAgent {
  readonly name: string;
  /** Whether the agent supports bounded multi-phase scenarios (ramp/waves). */
  readonly multiPhase: boolean;
  /** Whether the agent can run a multi-step request flow (L7 journey). */
  readonly flowCapable: boolean;
  /** Short human-readable description shown in the UI. */
  readonly description: string;
  /** Whether the agent is usable in the current environment. */
  available(): Promise<boolean>;
  run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult>;
}
