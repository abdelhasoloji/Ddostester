import type {
  EdgeAbsorptionContext,
  EdgeAbsorptionProvider,
  EdgeAbsorptionReport,
} from './types.js';

export interface EdgeAbsorptionConfig {
  /**
   * Pull connector: a metrics endpoint we GET (run window + tag as query params)
   * to read the edge's own seen/blocked/served counts for our traffic.
   */
  metricsUrl?: string;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Provenance label applied when the connector doesn't carry its own source. */
  sourceLabel?: string;
  /**
   * Lab/demo only: fixed counts returned with source 'mock', to exercise the
   * corroboration path without a live edge source. Clearly labelled.
   */
  mock?: { seen: number; blocked: number; rateLimited?: number; served: number };
}

export function edgeAbsorptionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EdgeAbsorptionConfig {
  const mock =
    (env.EDGE_ABSORPTION_MOCK ?? '').trim().toLowerCase() === 'true'
      ? {
          seen: Number(env.EDGE_ABSORPTION_MOCK_SEEN ?? 1000),
          blocked: Number(env.EDGE_ABSORPTION_MOCK_BLOCKED ?? 800),
          rateLimited: env.EDGE_ABSORPTION_MOCK_RATELIMITED
            ? Number(env.EDGE_ABSORPTION_MOCK_RATELIMITED)
            : undefined,
          served: Number(env.EDGE_ABSORPTION_MOCK_SERVED ?? 200),
        }
      : undefined;
  return {
    metricsUrl: env.EDGE_ABSORPTION_METRICS_URL?.trim() || undefined,
    timeoutMs: env.EDGE_ABSORPTION_TIMEOUT_MS ? Number(env.EDGE_ABSORPTION_TIMEOUT_MS) : undefined,
    sourceLabel: env.EDGE_ABSORPTION_SOURCE_LABEL?.trim() || undefined,
    mock,
  };
}

/** Default: no edge source → absorption stays one-sided (inferred only). */
export const noopEdgeAbsorptionProvider: EdgeAbsorptionProvider = {
  configured: false,
  async report() {
    return null;
  },
};

/** GETs JSON and returns it, or null. Injectable in tests. */
export type FetchJsonGet = (url: string, timeoutMs: number) => Promise<unknown>;

const defaultFetch: FetchJsonGet = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-wedos-shieldtest': 'edge-absorption-query' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function createEdgeAbsorptionProvider(
  config: EdgeAbsorptionConfig,
  fetchGet: FetchJsonGet = defaultFetch,
): EdgeAbsorptionProvider {
  const timeoutMs = config.timeoutMs ?? 5000;

  if (config.mock) {
    const m = config.mock;
    return {
      configured: true,
      async report(): Promise<EdgeAbsorptionReport> {
        return { ...m, source: config.sourceLabel ?? 'mock' };
      },
    };
  }

  if (config.metricsUrl) {
    const base = config.metricsUrl;
    return {
      configured: true,
      async report(ctx: EdgeAbsorptionContext): Promise<EdgeAbsorptionReport | null> {
        const u = new URL(base);
        u.searchParams.set('target', ctx.target);
        u.searchParams.set('tag', ctx.tag);
        u.searchParams.set('from', ctx.startedAt);
        u.searchParams.set('to', ctx.finishedAt);
        const raw = await fetchGet(u.toString(), timeoutMs).catch(() => null);
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const seen = num(r.seen);
        const blocked = num(r.blocked);
        const served = num(r.served);
        if (seen === undefined || blocked === undefined) return null;
        return {
          seen,
          blocked,
          rateLimited: num(r.rateLimited),
          served: served ?? Math.max(0, seen - blocked),
          source: (typeof r.source === 'string' && r.source) || config.sourceLabel || 'edge',
        };
      },
    };
  }

  return noopEdgeAbsorptionProvider;
}
