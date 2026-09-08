import { runLoadTest } from '../engine/loadTest.js';
import { runSlowloris } from '../engine/slowloris.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import type { AttackAgent } from './types.js';

/** Default agent: built-in bounded HTTP generator (GET/POST, RPS cap). */
export class BuiltinHttpAgent implements AttackAgent {
  readonly name = 'builtin-http';
  readonly multiPhase = true;
  readonly flowCapable = true;
  readonly correlationCapable = true;
  readonly description =
    'Built-in bounded HTTP generator (no external tool required) — flows with correlation.';
  async available(): Promise<boolean> {
    return true;
  }
  run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    if (config.slowloris) return runSlowloris(config, allowedHosts, killSignal, onProgress);
    return runLoadTest(config, allowedHosts, killSignal, onProgress);
  }
}
