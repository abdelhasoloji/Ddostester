import { randomUUID } from 'node:crypto';
import type { LoadTestConfig, LoadTestResult } from './types.js';

export class TargetNotAllowedError extends Error {}
export class InvalidConfigError extends Error {}

/**
 * Valide la config. Refuse toute cible hors liste blanche et tout test non
 * explicitement autorisé. C'est la barrière anti-usage abusif : l'outil ne
 * peut viser que des hôtes que l'opérateur a déclarés siens.
 */
export function validateConfig(config: LoadTestConfig, allowedHosts: string[]): void {
  if (!config.authorized) {
    throw new InvalidConfigError(
      "Le test doit être explicitement autorisé (authorized=true) : confirme que la cible t'appartient.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new InvalidConfigError(`URL invalide : ${config.url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new InvalidConfigError('Seuls http et https sont supportés.');
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new TargetNotAllowedError(
      `Cible « ${parsed.hostname} » absente de la liste blanche ALLOWED_TARGETS. ` +
        `Ajoute uniquement des hôtes que tu possèdes ou pour lesquels tu es autorisé.`,
    );
  }
  if (config.concurrency < 1 || config.concurrency > 1000) {
    throw new InvalidConfigError('concurrency doit être entre 1 et 1000.');
  }
  if (config.durationSec < 1 || config.durationSec > 3600) {
    throw new InvalidConfigError('durationSec doit être entre 1 et 3600.');
  }
  if (!(config.maxRps > 0)) {
    throw new InvalidConfigError('maxRps doit être > 0 (plafond de sécurité obligatoire).');
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Exécute un test de charge : `concurrency` boucles en parallèle envoient des
 * requêtes pendant `durationSec`, en respectant un plafond global `maxRps`
 * (throttling par fenêtre glissante simple).
 */
export async function runLoadTest(
  config: LoadTestConfig,
  allowedHosts: string[],
  killSignal?: AbortSignal,
): Promise<LoadTestResult> {
  validateConfig(config, allowedHosts);

  const id = randomUUID();
  const startedAt = new Date();
  const timeoutMs = config.timeoutMs ?? 10_000;
  const deadline = startedAt.getTime() + config.durationSec * 1000;
  const shouldStop = (): boolean => Date.now() >= deadline || killSignal?.aborted === true;

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let successful = 0;
  let failed = 0;
  let sent = 0;

  // Throttle: on ne dépasse jamais maxRps requêtes par seconde (global).
  let windowStart = Date.now();
  let windowCount = 0;

  async function reserveSlot(): Promise<boolean> {
    while (!shouldStop()) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount < config.maxRps) {
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
        // Draine le corps pour libérer la connexion.
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

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

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
