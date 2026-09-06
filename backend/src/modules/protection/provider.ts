import type { ProtectionContext, ProtectionMeasurement, ProtectionProvider } from './types.js';

export interface ProtectionConfig {
  /**
   * Push connector: endpoint we POST the run window to; it replies with the
   * detection/mitigation timings. Takes precedence over `metricsUrl`.
   */
  webhookUrl?: string;
  /**
   * Pull connector: metrics endpoint we GET (run window passed as query
   * params) to read the timings. Used when no `webhookUrl` is set. This is the
   * pluggable path for a protection stack that exposes metrics rather than
   * calling us back.
   */
  metricsUrl?: string;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
  /**
   * Provenance label applied to a measurement that does not carry its own
   * `source` (e.g. 'scrubbing', 'cloudflare'). Makes the origin explicit on the
   * run; never overrides a source reported by the connector itself.
   */
  sourceLabel?: string;
  /**
   * Lab/demo only: fixed timings returned with source 'mock', to exercise the
   * measured-WRS path end to end without a live protection source. Clearly
   * labelled — never presented as real measurement.
   */
  mock?: { detectionTimeSec: number; mitigationTimeSec: number };
}

/** Reads the protection configuration from the environment. */
export function protectionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProtectionConfig {
  const mock =
    (env.PROTECTION_MOCK ?? '').trim().toLowerCase() === 'true'
      ? {
          detectionTimeSec: Number(env.PROTECTION_MOCK_DETECTION_SEC ?? 15),
          mitigationTimeSec: Number(env.PROTECTION_MOCK_MITIGATION_SEC ?? 45),
        }
      : undefined;
  return {
    webhookUrl: env.PROTECTION_WEBHOOK_URL?.trim() || undefined,
    metricsUrl: env.PROTECTION_METRICS_URL?.trim() || undefined,
    timeoutMs: env.PROTECTION_TIMEOUT_MS ? Number(env.PROTECTION_TIMEOUT_MS) : undefined,
    sourceLabel: env.PROTECTION_SOURCE_LABEL?.trim() || undefined,
    mock,
  };
}

/** Default: no protection source → the WRS keeps its estimate. */
export const noopProtectionProvider: ProtectionProvider = {
  configured: false,
  async measure() {
    return null;
  },
};

/** POSTs JSON and returns parsed JSON, or null. Injected in tests. */
export type FetchJson = (url: string, payload: unknown, timeoutMs: number) => Promise<unknown>;
/** GETs JSON and returns parsed JSON, or null. Injected in tests. */
export type FetchJsonGet = (url: string, timeoutMs: number) => Promise<unknown>;

const fetchJson: FetchJson = async (url, payload, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wedos-shieldtest': 'protection-query' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchJsonGet: FetchJsonGet = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-wedos-shieldtest': 'protection-query' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

/** Coerces an unknown payload into a measurement, or null if invalid. */
export function parseMeasurement(raw: unknown): ProtectionMeasurement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const d = Number(o.detectionTimeSec);
  const m = Number(o.mitigationTimeSec);
  if (!Number.isFinite(d) || !Number.isFinite(m) || d < 0 || m < 0) return null;
  return {
    detectionTimeSec: d,
    mitigationTimeSec: m,
    source: typeof o.source === 'string' ? o.source : undefined,
  };
}

/** Stamps a provenance label when the connector did not report its own source. */
function withSource(
  m: ProtectionMeasurement | null,
  label: string | undefined,
): ProtectionMeasurement | null {
  if (!m || m.source || !label) return m;
  return { ...m, source: label };
}

/** Push connector: POSTs the run window, reads the timings from the reply. */
class WebhookProtectionProvider implements ProtectionProvider {
  readonly configured = true;
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly label: string | undefined,
    private readonly post: FetchJson = fetchJson,
  ) {}

  async measure(ctx: ProtectionContext): Promise<ProtectionMeasurement | null> {
    try {
      const raw = await this.post(this.url, ctx, this.timeoutMs);
      return withSource(parseMeasurement(raw), this.label);
    } catch {
      return null; // best-effort: fall back to the estimate
    }
  }
}

/** Pull connector: GETs a metrics endpoint with the run window as query params. */
class PollProtectionProvider implements ProtectionProvider {
  readonly configured = true;
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly label: string | undefined,
    private readonly get: FetchJsonGet = fetchJsonGet,
  ) {}

  async measure(ctx: ProtectionContext): Promise<ProtectionMeasurement | null> {
    try {
      const u = new URL(this.url);
      u.searchParams.set('campaignId', ctx.campaignId);
      u.searchParams.set('target', ctx.target);
      u.searchParams.set('from', ctx.startedAt);
      u.searchParams.set('to', ctx.finishedAt);
      const raw = await this.get(u.toString(), this.timeoutMs);
      return withSource(parseMeasurement(raw), this.label);
    } catch {
      return null; // best-effort: fall back to the estimate
    }
  }
}

/**
 * Lab/demo provider: returns fixed timings tagged source 'mock' so the
 * measured-WRS path can be exercised without a live protection source. The
 * 'mock' source is surfaced on the run, so it is never mistaken for real data.
 */
class MockProtectionProvider implements ProtectionProvider {
  readonly configured = true;
  constructor(private readonly m: { detectionTimeSec: number; mitigationTimeSec: number }) {}
  async measure(): Promise<ProtectionMeasurement> {
    return { ...this.m, source: 'mock' };
  }
}

/** Validates an http(s) endpoint, throwing a config error otherwise. */
function requireHttpUrl(raw: string, name: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name}: invalid URL`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error(`${name} must be http or https`);
  }
}

/**
 * Builds a protection provider from config (no-op when none configured).
 * Precedence: webhook (push) > metrics (pull) > mock > none.
 */
export function createProtectionProvider(
  cfg: ProtectionConfig,
  post?: FetchJson,
  get?: FetchJsonGet,
): ProtectionProvider {
  const timeoutMs = cfg.timeoutMs ?? 5000;
  if (cfg.webhookUrl) {
    requireHttpUrl(cfg.webhookUrl, 'PROTECTION_WEBHOOK_URL');
    return new WebhookProtectionProvider(cfg.webhookUrl, timeoutMs, cfg.sourceLabel, post);
  }
  if (cfg.metricsUrl) {
    requireHttpUrl(cfg.metricsUrl, 'PROTECTION_METRICS_URL');
    return new PollProtectionProvider(cfg.metricsUrl, timeoutMs, cfg.sourceLabel, get);
  }
  if (cfg.mock) {
    if (
      !Number.isFinite(cfg.mock.detectionTimeSec) ||
      !Number.isFinite(cfg.mock.mitigationTimeSec)
    ) {
      throw new Error('PROTECTION_MOCK_* must be numbers.');
    }
    return new MockProtectionProvider(cfg.mock);
  }
  return noopProtectionProvider;
}
