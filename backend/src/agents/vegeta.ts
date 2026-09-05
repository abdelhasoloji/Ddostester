import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult, ScenarioPhase } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';
import { AgentError, type AttackAgent } from './types.js';
import { runProcess, binaryAvailable } from './proc.js';

/**
 * Adapter to Vegeta (fixed-rate HTTP load generator, operated by the team).
 * Rate capped via `-rate`; bounded HTTP load only.
 */

/** Builds the Vegeta targets file (one request). Pure function. */
export function buildVegetaTarget(config: LoadTestConfig, bodyFile?: string): string {
  const method = (config.method ?? 'GET').toUpperCase();
  const lines = [`${method} ${config.url}`];
  for (const [k, v] of Object.entries(config.headers ?? {})) lines.push(`${k}: ${v}`);
  if (method === 'POST' && bodyFile) lines.push(`@${bodyFile}`);
  return lines.join('\n') + '\n';
}

interface VegetaReport {
  latencies?: {
    mean?: number;
    '50th'?: number;
    '95th'?: number;
    '99th'?: number;
    max?: number;
    min?: number;
  };
  requests?: number;
  rate?: number;
  success?: number;
  status_codes?: Record<string, number>;
  errors?: string[] | null;
}

const nsToMs = (n: number | undefined): number => Number(((n ?? 0) / 1e6).toFixed(2));

/** Converts a Vegeta report (report -type=json) into a LoadTestResult. Pure function. */
export function parseVegetaReport(
  rep: VegetaReport,
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
  const total = rep.requests ?? 0;
  const success = rep.success ?? 1;
  const failed = Math.round(total * (1 - success));
  const l = rep.latencies ?? {};
  const statusCounts: Record<string, number> = {};
  for (const [code, n] of Object.entries(rep.status_codes ?? {})) {
    const bucket = `${code[0]}xx`;
    statusCounts[bucket] = (statusCounts[bucket] ?? 0) + n;
  }
  const errors: Record<string, number> = {};
  for (const e of rep.errors ?? []) errors[e] = (errors[e] ?? 0) + 1;
  return {
    id: meta.id,
    config: meta.config,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts,
    latencyMs: {
      min: nsToMs(l.min),
      max: nsToMs(l.max),
      mean: nsToMs(l.mean),
      p50: nsToMs(l['50th']),
      p95: nsToMs(l['95th']),
      p99: nsToMs(l['99th']),
    },
    actualRps: Number((rep.rate ?? 0).toFixed(2)),
    errors,
  };
}

/** Sums several reports (sequential phases). Pure function. */
export function mergeResults(
  parts: LoadTestResult[],
  meta: { id: string; config: LoadTestConfig; startedAt: string; finishedAt: string },
): LoadTestResult {
  if (parts.length === 1) return { ...parts[0], ...meta };
  const total = parts.reduce((s, p) => s + p.totalRequests, 0);
  const failed = parts.reduce((s, p) => s + p.failed, 0);
  const statusCounts: Record<string, number> = {};
  const errors: Record<string, number> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.statusCounts))
      statusCounts[k] = (statusCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.errors)) errors[k] = (errors[k] ?? 0) + v;
  }
  const wmean = (sel: (r: LoadTestResult) => number) =>
    total
      ? Number((parts.reduce((s, p) => s + sel(p) * p.totalRequests, 0) / total).toFixed(2))
      : 0;
  const elapsed = (Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)) / 1000;
  return {
    ...meta,
    totalRequests: total,
    successful: total - failed,
    failed,
    statusCounts,
    errors,
    latencyMs: {
      min: Math.min(...parts.map((p) => p.latencyMs.min)),
      max: Math.max(...parts.map((p) => p.latencyMs.max)),
      mean: wmean((p) => p.latencyMs.mean),
      p50: wmean((p) => p.latencyMs.p50),
      p95: wmean((p) => p.latencyMs.p95),
      p99: wmean((p) => p.latencyMs.p99),
    },
    actualRps: Number((total / Math.max(elapsed, 0.001)).toFixed(2)),
  };
}

export class VegetaAgent implements AttackAgent {
  readonly name = 'vegeta';
  readonly multiPhase = true;
  readonly description = 'Vegeta (external) — fixed-rate load, runs phases sequentially.';
  constructor(private readonly bin = process.env.VEGETA_BIN ?? 'vegeta') {}

  available(): Promise<boolean> {
    return binaryAvailable(this.bin, '-version');
  }

  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    _onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    validateConfig(config, allowedHosts);
    if (!(await this.available())) {
      throw new AgentError(
        `vegeta agent unavailable (binary "${this.bin}"). Install Vegeta or choose AGENT=builtin.`,
      );
    }
    const dir = await mkdtemp(join(tmpdir(), 'shieldtest-vegeta-'));
    const startedAt = new Date().toISOString();
    try {
      let bodyFile: string | undefined;
      if ((config.method ?? 'GET').toUpperCase() === 'POST' && config.body != null) {
        bodyFile = join(dir, 'body.txt');
        await writeFile(bodyFile, config.body, 'utf8');
      }
      const targetsFile = join(dir, 'targets.txt');
      await writeFile(targetsFile, buildVegetaTarget(config, bodyFile), 'utf8');

      const phases: ScenarioPhase[] = config.phases?.length
        ? config.phases
        : [{ maxRps: config.maxRps, durationSec: config.durationSec }];

      const parts: LoadTestResult[] = [];
      for (let i = 0; i < phases.length; i++) {
        if (killSignal?.aborted) break;
        const ph = phases[i];
        const resultsBin = join(dir, `r${i}.bin`);
        await runProcess(
          this.bin,
          [
            'attack',
            '-targets',
            targetsFile,
            '-rate',
            `${ph.maxRps}/1s`,
            '-duration',
            `${ph.durationSec}s`,
            '-output',
            resultsBin,
          ],
          { killSignal },
        );
        const rep = await runProcess(this.bin, ['report', '-type', 'json', resultsBin], {
          killSignal,
        });
        parts.push(
          parseVegetaReport(JSON.parse(rep.stdout || '{}'), {
            id: `p${i}`,
            config,
            startedAt,
            finishedAt: new Date().toISOString(),
          }),
        );
      }
      return mergeResults(parts.length ? parts : [emptyResult(config, startedAt)], {
        id: randomUUID(),
        config,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function emptyResult(config: LoadTestConfig, startedAt: string): LoadTestResult {
  return {
    id: 'empty',
    config,
    startedAt,
    finishedAt: startedAt,
    totalRequests: 0,
    successful: 0,
    failed: 0,
    statusCounts: {},
    latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
    actualRps: 0,
    errors: {},
  };
}
