import type { ProtectionContext, ProtectionMeasurement, ProtectionProvider } from './types.js';

export interface ProtectionConfig {
  /** Endpoint queried for real detection/mitigation timings. */
  webhookUrl?: string;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
}

/** Reads the protection configuration from the environment. */
export function protectionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProtectionConfig {
  return {
    webhookUrl: env.PROTECTION_WEBHOOK_URL?.trim() || undefined,
    timeoutMs: env.PROTECTION_TIMEOUT_MS ? Number(env.PROTECTION_TIMEOUT_MS) : undefined,
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

class WebhookProtectionProvider implements ProtectionProvider {
  readonly configured = true;
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly post: FetchJson = fetchJson,
  ) {}

  async measure(ctx: ProtectionContext): Promise<ProtectionMeasurement | null> {
    try {
      const raw = await this.post(this.url, ctx, this.timeoutMs);
      return parseMeasurement(raw);
    } catch {
      return null; // best-effort: fall back to the estimate
    }
  }
}

/** Builds a protection provider from config (no-op when none configured). */
export function createProtectionProvider(
  cfg: ProtectionConfig,
  post?: FetchJson,
): ProtectionProvider {
  if (!cfg.webhookUrl) return noopProtectionProvider;
  let u: URL;
  try {
    u = new URL(cfg.webhookUrl);
  } catch {
    throw new Error('PROTECTION_WEBHOOK_URL: invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('PROTECTION_WEBHOOK_URL must be http or https');
  }
  return new WebhookProtectionProvider(cfg.webhookUrl, cfg.timeoutMs ?? 5000, post);
}
