import { randomUUID } from 'node:crypto';
import type { LoadTestConfig, LoadTestResult } from './types.js';

export class TargetNotAllowedError extends Error {}
export class InvalidConfigError extends Error {}

/**
 * Validates the config. Rejects any target outside the allowlist and any test
 * not explicitly authorized. This is the anti-abuse barrier: the tool can only
 * aim at hosts the operator has declared as their own.
 */
export function validateConfig(config: LoadTestConfig, allowedHosts: string[]): void {
  if (!config.authorized) {
    throw new InvalidConfigError(
      'The test must be explicitly authorized (authorized=true): confirm the target belongs to you.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new InvalidConfigError(`Invalid URL: ${config.url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new InvalidConfigError('Only http and https are supported.');
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new TargetNotAllowedError(
      `Target "${parsed.hostname}" is not in the ALLOWED_TARGETS allowlist. ` +
        `Only add hosts you own or are authorized to test.`,
    );
  }
  if (config.concurrency < 1 || config.concurrency > 1000) {
    throw new InvalidConfigError('concurrency must be between 1 and 1000.');
  }
  if (config.durationSec < 1 || config.durationSec > 3600) {
    throw new InvalidConfigError('durationSec must be between 1 and 3600.');
  }
  if (!(config.maxRps > 0)) {
    throw new InvalidConfigError('maxRps must be > 0 (mandatory safety cap).');
  }
  if (config.phases) {
    if (config.phases.length === 0 || config.phases.length > 12) {
      throw new InvalidConfigError('A scenario must have between 1 and 12 phases.');
    }
    for (const p of config.phases) {
      if (!(p.maxRps > 0)) throw new InvalidConfigError('Each phase must have maxRps > 0.');
      if (p.durationSec < 1) throw new InvalidConfigError('Each phase must last ≥ 1 s.');
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Runs a load test: `concurrency` parallel loops send requests for
 * `durationSec`, honouring a global `maxRps` cap (simple sliding-window
 * throttling).
 */
export interface LoadProgress {
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
}

export async function runLoadTest(
  config: LoadTestConfig,
  allowedHosts: string[],
  killSignal?: AbortSignal,
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadTestResult> {
  validateConfig(config, allowedHosts);

  const id = randomUUID();
  const startedAt = new Date();
  const timeoutMs = config.timeoutMs ?? 10_000;
  // Phases: by default a single phase (durationSec @ maxRps).
  const phases = config.phases?.length
    ? config.phases
    : [{ maxRps: config.maxRps, durationSec: config.durationSec }];
  const totalMs = phases.reduce((s, p) => s + p.durationSec * 1000, 0);
  const deadline = startedAt.getTime() + totalMs;
  const shouldStop = (): boolean => Date.now() >= deadline || killSignal?.aborted === true;

  /** Rate allowed at the current instant based on the ongoing phase. */
  function currentMaxRps(): number {
    let t = Date.now() - startedAt.getTime();
    for (const p of phases) {
      if (t < p.durationSec * 1000) return p.maxRps;
      t -= p.durationSec * 1000;
    }
    return phases[phases.length - 1].maxRps;
  }

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let successful = 0;
  let failed = 0;
  let sent = 0;

  // Throttle: never exceed maxRps requests per second (global).
  let windowStart = Date.now();
  let windowCount = 0;

  async function reserveSlot(): Promise<boolean> {
    while (!shouldStop()) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount < currentMaxRps()) {
        windowCount++;
        return true;
      }
      await new Promise((r) => setTimeout(r, Math.max(1, 1000 - (now - windowStart))));
    }
    return false;
  }

  async function worker(): Promise<void> {
    while (!shouldStop()) {
      const ok = await reserveSlot();
      if (!ok) return;
      const t0 = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(config.url, {
          method: config.method ?? 'GET',
          headers: config.headers,
          body: config.body,
          signal: controller.signal,
        });
        latencies.push(performance.now() - t0);
        sent++;
        const bucket = `${Math.floor(res.status / 100)}xx`;
        statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
        if (res.ok) successful++;
        else failed++;
        // Drain the body to release the connection.
        await res.arrayBuffer().catch(() => undefined);
      } catch (err) {
        sent++;
        failed++;
        const name = err instanceof Error ? err.name : 'UnknownError';
        errors[name] = (errors[name] ?? 0) + 1;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // Emit progress ~1×/s (real-time, CAM-04).
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt.getTime()) / 1000;
      onProgress({
        sent,
        successful,
        failed,
        elapsedSec: Number(elapsed.toFixed(1)),
        actualRps: Number((sent / Math.max(elapsed, 0.001)).toFixed(2)),
      });
    }, 1000);
    progressTimer.unref?.();
  }

  try {
    await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  const finishedAt = new Date();
  const sorted = [...latencies].sort((a, b) => a - b);
  const elapsedSec = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  return {
    id,
    config,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalRequests: sent,
    successful,
    failed,
    statusCounts,
    latencyMs: {
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      mean: Number(mean.toFixed(2)),
      p50: Number(percentile(sorted, 50).toFixed(2)),
      p95: Number(percentile(sorted, 95).toFixed(2)),
      p99: Number(percentile(sorted, 99).toFixed(2)),
    },
    actualRps: Number((sent / Math.max(elapsedSec, 0.001)).toFixed(2)),
    errors,
  };
}
