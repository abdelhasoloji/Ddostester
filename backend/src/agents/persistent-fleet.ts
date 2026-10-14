import type { AttackAgent } from './types.js';
import { AgentError } from './types.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import { validateConfig, type LoadProgress } from '../engine/loadTest.js';
import { FLEET_LIMITS } from '../config/limits.js';
import { summarizeFleet, type FleetShardEvidence } from '../modules/fleet/summary.js';

export interface PersistentFleetDriver {
  start(config: LoadTestConfig, allowedHosts: string[]): Promise<string>;
  stop(id: string): Promise<void>;
  snapshot(id: string): Promise<{
    state: string;
    shards: (FleetShardEvidence & {
      progress?: { sent: number; successful: number; failed: number };
    })[];
  } | null>;
}
let driver: PersistentFleetDriver | undefined;
/** The application owns the driver and its database lifecycle. */
export function bindPersistentFleet(value: PersistentFleetDriver): () => void {
  driver = value;
  return () => {
    if (driver === value) driver = undefined;
  };
}
export class PersistentFleetHttpAgent implements AttackAgent {
  readonly name = 'iot-fleet';
  readonly multiPhase = false;
  readonly flowCapable = false;
  readonly endpointCapable = false;
  readonly correlationCapable = false;
  readonly description =
    'One to three enrolled VPS Lab agents; bounded GET, shared caps of 15 RPS, 6 workers, 60 seconds.';
  async available() {
    return !!driver;
  }
  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    signal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    const control = driver;
    if (!control) throw new AgentError('Enrolled Fleet is unavailable');
    validateConfig(config, allowedHosts);
    if (
      (config.method && config.method !== 'GET') ||
      config.body ||
      config.phases ||
      config.flow ||
      config.endpoints ||
      config.iotProfile ||
      config.dataset ||
      config.userAgents ||
      config.assertion ||
      config.cacheBust ||
      config.noKeepAlive ||
      config.parallelism ||
      config.slowloris
    )
      throw new AgentError('This Fleet increment supports a single bounded GET campaign');
    if (
      config.maxRps < (config.fleetDeviceIds?.length ?? 3) ||
      config.maxRps > FLEET_LIMITS.maxRps ||
      config.concurrency < (config.fleetDeviceIds?.length ?? 3) ||
      config.concurrency > FLEET_LIMITS.maxConcurrency ||
      config.durationSec < FLEET_LIMITS.minDurationSec ||
      config.durationSec > FLEET_LIMITS.maxDurationSec
    )
      throw new AgentError('Fleet envelope: 3–15 RPS, 3–6 concurrent, 10–60 seconds');
    if (signal?.aborted) throw new AgentError('Fleet cancelled before launch');
    const startedAt = new Date().toISOString();
    const id = await control.start(config, allowedHosts);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= control.stop(id);
      void stopping.catch(() => {});
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    try {
      const deadline = Date.now() + config.durationSec * 1000 + FLEET_LIMITS.stopTimeoutMs;
      while (Date.now() < deadline) {
        if (stopping) await stopping;
        const snapshot = await control.snapshot(id);
        if (!snapshot) throw new AgentError('Fleet campaign disappeared');
        const counters = snapshot.shards.map((s) => {
          const g = s.result?.generator as LoadTestResult | undefined;
          return g
            ? { sent: g.totalRequests, successful: g.successful, failed: g.failed }
            : (s.progress ?? { sent: 0, successful: 0, failed: 0 });
        });
        const sum = (key: 'sent' | 'successful' | 'failed') =>
          counters.reduce((n, c) => n + c[key], 0);
        const elapsedSec = (Date.now() - Date.parse(startedAt)) / 1000;
        onProgress?.({
          runId: id,
          sent: sum('sent'),
          successful: sum('successful'),
          failed: sum('failed'),
          elapsedSec,
          actualRps: elapsedSec > 0 ? sum('sent') / elapsedSec : 0,
        });
        if (snapshot.state === 'SETTLED')
          return summarizeFleet(id, config, startedAt, snapshot.shards);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await control.stop(id);
      const last = await control.snapshot(id);
      if (!last) throw new AgentError('Fleet final evidence unavailable');
      return summarizeFleet(id, config, startedAt, last.shards);
    } finally {
      signal?.removeEventListener('abort', stop);
      await control.stop(id);
    }
  }
}
