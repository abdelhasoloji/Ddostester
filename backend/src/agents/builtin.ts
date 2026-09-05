import { runLoadTest } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import type { AttackAgent } from './types.js';

/** Default agent: built-in bounded HTTP generator (GET/POST, RPS cap). */
export class BuiltinHttpAgent implements AttackAgent {
  readonly name = 'builtin-http';
  async available(): Promise<boolean> {
    return true;
  }
  run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    return runLoadTest(config, allowedHosts, killSignal, onProgress);
  }
}
