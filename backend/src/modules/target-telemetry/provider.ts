import { readBoundedBody } from '../../util/http-body.js';
import { IO_LIMITS } from '../../config/limits.js';
import type { TargetSample, TargetTelemetryContext, TargetTelemetryProvider } from './types.js';

export interface TargetTelemetryConfig {
  /** Metrics endpoint we GET (per-run query params) for host counters. */
  metricsUrl?: string;
  /** Per-request timeout in ms (default 3000). */
  timeoutMs?: number;
  /**
   * Lab/demo only: fixed sample returned so the correlation path can be
   * exercised without a live source. Clearly a demo value, never real data.
   */
  mock?: TargetSample;
}

/** Reads the target-telemetry configuration from the environment. */
export function targetTelemetryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TargetTelemetryConfig {
  const num = (v?: string): number | undefined =>
    v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  const mock =
    (env.TARGET_TELEMETRY_MOCK ?? '').trim().toLowerCase() === 'true'
      ? {
          at: '',
          cpuPct: num(env.TARGET_TELEMETRY_MOCK_CPU_PCT) ?? 40,
          conntrack: num(env.TARGET_TELEMETRY_MOCK_CONNTRACK) ?? 1000,
          nicRxMbps: num(env.TARGET_TELEMETRY_MOCK_NIC_RX_MBPS) ?? 50,
          nicTxMbps: num(env.TARGET_TELEMETRY_MOCK_NIC_TX_MBPS) ?? 20,
        }
      : undefined;
  return {
    metricsUrl: env.TARGET_TELEMETRY_METRICS_URL?.trim() || undefined,
    timeoutMs: num(env.TARGET_TELEMETRY_TIMEOUT_MS),
    mock,
  };
}

/** Default: no telemetry source → no host series (correlation still has probe/generator). */
export const noopTargetTelemetryProvider: TargetTelemetryProvider = {
  configured: false,
  async sample() {
    return null;
  },
};

/** GETs JSON, or null. Injected in tests. */
export type FetchJsonGet = (url: string, timeoutMs: number) => Promise<unknown>;

const fetchJsonGet: FetchJsonGet = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: { 'x-wedos-shieldtest': 'target-telemetry-query' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return JSON.parse(
      new TextDecoder().decode(await readBoundedBody(res.body, IO_LIMITS.responseBytes)),
    );
  } finally {
    clearTimeout(timer);
  }
};

/** Coerces an unknown payload into a sample, or null if it carries no metric. */
export function parseTargetSample(
  raw: unknown,
  at: string = new Date().toISOString(),
): TargetSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const sample: TargetSample = {
    at,
    cpuPct: num(o.cpuPct),
    conntrack: num(o.conntrack),
    nicRxMbps: num(o.nicRxMbps),
    nicTxMbps: num(o.nicTxMbps),
    receivedRequests:
      typeof o.receivedRequests === 'number' &&
      Number.isSafeInteger(o.receivedRequests) &&
      o.receivedRequests >= 0
        ? o.receivedRequests
        : undefined,
    receiptComplete: typeof o.receiptComplete === 'boolean' ? o.receiptComplete : undefined,
    sourceIps: Array.isArray(o.sourceIps)
      ? o.sourceIps.filter((v): v is string => typeof v === 'string').slice(0, 16)
      : undefined,
    source: typeof o.source === 'string' ? o.source.slice(0, 128) : undefined,
    targetPodUid: typeof o.targetPodUid === 'string' ? o.targetPodUid.slice(0, 128) : undefined,
  };
  const hasMetric =
    sample.cpuPct != null ||
    sample.conntrack != null ||
    sample.nicRxMbps != null ||
    sample.nicTxMbps != null ||
    sample.receivedRequests != null;
  return hasMetric ? sample : null;
}

/** Pull connector: GETs a metrics endpoint with the run window as query params. */
class PollTargetTelemetryProvider implements TargetTelemetryProvider {
  readonly configured = true;
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly get: FetchJsonGet = fetchJsonGet,
  ) {}

  async sample(ctx: TargetTelemetryContext): Promise<TargetSample | null> {
    try {
      const u = new URL(this.url);
      u.searchParams.set('campaignId', ctx.campaignId);
      if (ctx.runId) u.searchParams.set('runId', ctx.runId);
      u.searchParams.set('target', ctx.target);
      return parseTargetSample(await this.get(u.toString(), this.timeoutMs));
    } catch {
      return null; // best-effort: correlation continues without host counters
    }
  }
}

/** Lab/demo provider: returns the configured fixed sample (never real data). */
class MockTargetTelemetryProvider implements TargetTelemetryProvider {
  readonly configured = true;
  constructor(private readonly m: TargetSample) {}
  async sample(): Promise<TargetSample> {
    return { ...this.m, at: new Date().toISOString() };
  }
}

/** Builds a provider from config (no-op when none configured). Pull > mock > none. */
export function createTargetTelemetryProvider(
  cfg: TargetTelemetryConfig,
  get?: FetchJsonGet,
): TargetTelemetryProvider {
  const timeoutMs = cfg.timeoutMs ?? 3000;
  if (cfg.metricsUrl) {
    let u: URL;
    try {
      u = new URL(cfg.metricsUrl);
    } catch {
      throw new Error('TARGET_TELEMETRY_METRICS_URL: invalid URL');
    }
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error('TARGET_TELEMETRY_METRICS_URL must be http or https');
    }
    return new PollTargetTelemetryProvider(cfg.metricsUrl, timeoutMs, get);
  }
  if (cfg.mock) return new MockTargetTelemetryProvider(cfg.mock);
  return noopTargetTelemetryProvider;
}

export interface TargetTelemetrySummary {
  samples: number;
  receivedRequestsMax?: number;
  receiptComplete?: boolean;
  sourceIps?: string[];
  cpuPctMax?: number;
  conntrackMax?: number;
  nicRxMbpsMax?: number;
  nicTxMbpsMax?: number;
}

/** Pure peak-summary of a host-telemetry series (for the report). */
export function summarizeTargetTelemetry(series: TargetSample[]): TargetTelemetrySummary {
  const peak = (pick: (s: TargetSample) => number | undefined): number | undefined => {
    const vals = series.map(pick).filter((v): v is number => v != null);
    return vals.length ? Math.max(...vals) : undefined;
  };
  return {
    samples: series.length,
    ...(series.some((s) => s.receivedRequests !== undefined)
      ? {
          receivedRequestsMax: peak((s) => s.receivedRequests),
          receiptComplete: series.some((s) => s.receiptComplete !== undefined)
            ? series.every(
                (s, i) =>
                  s.receiptComplete === true &&
                  s.receivedRequests !== undefined &&
                  (i === 0 || s.receivedRequests >= (series[i - 1].receivedRequests ?? Infinity)),
              ) && new Set(series.map((s) => s.targetPodUid).filter(Boolean)).size <= 1
            : undefined,
          sourceIps: [...new Set(series.flatMap((s) => s.sourceIps ?? []))],
        }
      : {}),
    cpuPctMax: peak((s) => s.cpuPct),
    conntrackMax: peak((s) => s.conntrack),
    nicRxMbpsMax: peak((s) => s.nicRxMbps),
    nicTxMbpsMax: peak((s) => s.nicTxMbps),
  };
}
