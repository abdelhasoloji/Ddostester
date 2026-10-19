/**
 * Real generator port for the DRS orchestrator.
 *
 * The orchestrator sequences a frozen revision and never opens a socket itself: it asks a
 * `DrsGeneratorPort` for capacity and start/stop. Until now no production adapter existed,
 * so the state machine could only be exercised by tests.
 *
 * This adapter drives the existing bounded engine. It does not invent capacity: `capacity`
 * refuses a budget above the service ceiling, and `start` reports what the engine actually
 * did through `last`, which the evidence side reads instead of trusting the request.
 */
import { runLoadTest } from '../../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../../engine/types.js';
import { serviceCeiling, type DrsServiceCeiling } from '../../config/service-ceiling.js';
import type { DrsGeneratorPort } from './orchestrator.js';

type Budget = Parameters<DrsGeneratorPort['capacity']>[1];

export interface EngineGeneratorPort extends DrsGeneratorPort {
  /** Result of the most recent exposure, or undefined before the first start. */
  readonly last: LoadTestResult | undefined;
}

export function createEngineGeneratorPort(opts: {
  url: string;
  allowedHosts: string[];
  ceiling?: DrsServiceCeiling;
  run?: (
    config: LoadTestConfig,
    allowedHosts: string[],
    signal?: AbortSignal,
  ) => Promise<LoadTestResult>;
}): EngineGeneratorPort {
  const ceiling = opts.ceiling ?? serviceCeiling();
  const run = opts.run ?? runLoadTest;
  let last: LoadTestResult | undefined;

  const refusal = (b: Budget): string | null => {
    if (b.maxRps > ceiling.maxRps)
      return `budget ${b.maxRps} rps exceeds the service ceiling ${ceiling.maxRps}`;
    if (b.concurrency > ceiling.maxConcurrency)
      return `budget ${b.concurrency} concurrent exceeds the service ceiling ${ceiling.maxConcurrency}`;
    if (b.maxDurationSec > ceiling.maxDurationSec)
      return `budget ${b.maxDurationSec}s exceeds the service ceiling ${ceiling.maxDurationSec}s`;
    return null;
  };

  return {
    get last() {
      return last;
    },
    async capacity(vectorIds, budget) {
      if (vectorIds.length === 0) return { ready: false, reason: 'no vector selected' };
      const reason = refusal(budget);
      return reason
        ? { ready: false, reason }
        : { ready: true, reason: 'engine within the service ceiling' };
    },
    async start(vectorIds, budget, signal) {
      const reason = refusal(budget);
      if (reason) throw new Error(reason);
      if (vectorIds.length === 0) throw new Error('no vector selected');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const done = run(
        {
          url: opts.url,
          authorized: true,
          maxRps: budget.maxRps,
          concurrency: budget.concurrency,
          durationSec: budget.maxDurationSec,
        },
        opts.allowedHosts,
        controller.signal,
      )
        .then((result) => {
          last = result;
        })
        .catch(() => undefined);
      return {
        stop: async () => {
          controller.abort();
          await done;
          signal.removeEventListener('abort', onAbort);
          return { confirmed: true, stoppedAt: new Date().toISOString() };
        },
      };
    },
  };
}
