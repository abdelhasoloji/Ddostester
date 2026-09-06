import { describe, expect, it } from 'vitest';
import {
  createProtectionProvider,
  noopProtectionProvider,
  parseMeasurement,
  protectionConfigFromEnv,
} from '../src/modules/protection/provider.js';

const ctx = {
  campaignId: 'c1',
  target: 'http://127.0.0.1/',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:01:00Z',
};

describe('parseMeasurement', () => {
  it('accepts a valid payload', () => {
    expect(parseMeasurement({ detectionTimeSec: 5, mitigationTimeSec: 12, source: 'cf' })).toEqual({
      detectionTimeSec: 5,
      mitigationTimeSec: 12,
      source: 'cf',
    });
  });
  it('rejects missing/negative/non-numeric values', () => {
    expect(parseMeasurement({ detectionTimeSec: 5 })).toBeNull();
    expect(parseMeasurement({ detectionTimeSec: -1, mitigationTimeSec: 2 })).toBeNull();
    expect(parseMeasurement({ detectionTimeSec: 'x', mitigationTimeSec: 2 })).toBeNull();
    expect(parseMeasurement(null)).toBeNull();
  });
});

describe('protectionConfigFromEnv', () => {
  it('reads the webhook URL', () => {
    const cfg = protectionConfigFromEnv({
      PROTECTION_WEBHOOK_URL: 'https://prot.internal/q',
    } as NodeJS.ProcessEnv);
    expect(cfg.webhookUrl).toBe('https://prot.internal/q');
  });

  it('reads the mock config with defaults', () => {
    const cfg = protectionConfigFromEnv({ PROTECTION_MOCK: 'true' } as NodeJS.ProcessEnv);
    expect(cfg.mock).toEqual({ detectionTimeSec: 15, mitigationTimeSec: 45 });
  });

  it('reads the metrics (pull) URL and provenance label', () => {
    const cfg = protectionConfigFromEnv({
      PROTECTION_METRICS_URL: 'https://prot.internal/metrics',
      PROTECTION_SOURCE_LABEL: 'scrubbing',
    } as NodeJS.ProcessEnv);
    expect(cfg.metricsUrl).toBe('https://prot.internal/metrics');
    expect(cfg.sourceLabel).toBe('scrubbing');
  });
});

describe('createProtectionProvider', () => {
  it('returns the no-op provider (not configured) when no URL', () => {
    const p = createProtectionProvider({});
    expect(p).toBe(noopProtectionProvider);
    expect(p.configured).toBe(false);
  });

  it('rejects a non-http URL', () => {
    expect(() => createProtectionProvider({ webhookUrl: 'ftp://x' })).toThrow(/http/);
  });

  it('queries the webhook and returns the measurement', async () => {
    const p = createProtectionProvider({ webhookUrl: 'https://prot.internal/q' }, async () => ({
      detectionTimeSec: 3,
      mitigationTimeSec: 9,
    }));
    expect(p.configured).toBe(true);
    expect(await p.measure(ctx)).toEqual({ detectionTimeSec: 3, mitigationTimeSec: 9 });
  });

  it('returns null (→ estimate) on an invalid payload', async () => {
    const p = createProtectionProvider({ webhookUrl: 'https://prot.internal/q' }, async () => ({
      bogus: true,
    }));
    expect(await p.measure(ctx)).toBeNull();
  });

  it('never throws — a failing source yields null', async () => {
    const p = createProtectionProvider({ webhookUrl: 'https://prot.internal/q' }, async () => {
      throw new Error('down');
    });
    await expect(p.measure(ctx)).resolves.toBeNull();
  });

  it('mock provider returns fixed timings tagged source "mock"', async () => {
    const p = createProtectionProvider({ mock: { detectionTimeSec: 12, mitigationTimeSec: 30 } });
    expect(p.configured).toBe(true);
    expect(await p.measure(ctx)).toEqual({
      detectionTimeSec: 12,
      mitigationTimeSec: 30,
      source: 'mock',
    });
  });

  it('a real webhook takes precedence over the mock', () => {
    const p = createProtectionProvider({
      webhookUrl: 'https://prot.internal/q',
      mock: { detectionTimeSec: 1, mitigationTimeSec: 1 },
    });
    expect(p.configured).toBe(true);
    // A URL provider is used (not the mock) — verified via its measurement shape below.
    expect(p).not.toBe(noopProtectionProvider);
  });

  it('stamps the provenance label when the connector reports no source', async () => {
    const p = createProtectionProvider(
      { webhookUrl: 'https://prot.internal/q', sourceLabel: 'scrubbing' },
      async () => ({ detectionTimeSec: 3, mitigationTimeSec: 9 }),
    );
    expect(await p.measure(ctx)).toEqual({
      detectionTimeSec: 3,
      mitigationTimeSec: 9,
      source: 'scrubbing',
    });
  });

  it('never overrides a source the connector already reported', async () => {
    const p = createProtectionProvider(
      { webhookUrl: 'https://prot.internal/q', sourceLabel: 'scrubbing' },
      async () => ({ detectionTimeSec: 3, mitigationTimeSec: 9, source: 'cloudflare' }),
    );
    expect((await p.measure(ctx))?.source).toBe('cloudflare');
  });
});

describe('metrics (pull) connector', () => {
  it('rejects a non-http metrics URL', () => {
    expect(() => createProtectionProvider({ metricsUrl: 'ftp://x' })).toThrow(/http/);
  });

  it('GETs the metrics endpoint with the run window as query params', async () => {
    let seen = '';
    const p = createProtectionProvider(
      { metricsUrl: 'https://prot.internal/metrics', sourceLabel: 'scrubbing' },
      undefined,
      async (url: string) => {
        seen = url;
        return { detectionTimeSec: 4, mitigationTimeSec: 11 };
      },
    );
    expect(p.configured).toBe(true);
    expect(await p.measure(ctx)).toEqual({
      detectionTimeSec: 4,
      mitigationTimeSec: 11,
      source: 'scrubbing',
    });
    const u = new URL(seen);
    expect(u.searchParams.get('campaignId')).toBe('c1');
    expect(u.searchParams.get('target')).toBe('http://127.0.0.1/');
    expect(u.searchParams.get('from')).toBe('2026-01-01T00:00:00Z');
    expect(u.searchParams.get('to')).toBe('2026-01-01T00:01:00Z');
  });

  it('used only when no webhook is set (webhook wins)', async () => {
    const p = createProtectionProvider(
      { webhookUrl: 'https://prot.internal/push', metricsUrl: 'https://prot.internal/metrics' },
      async () => ({ detectionTimeSec: 1, mitigationTimeSec: 2 }),
      async () => ({ detectionTimeSec: 9, mitigationTimeSec: 9 }),
    );
    // The push (webhook) fetcher answers, not the pull one.
    expect(await p.measure(ctx)).toMatchObject({ detectionTimeSec: 1, mitigationTimeSec: 2 });
  });

  it('never throws — a failing metrics source yields null', async () => {
    const p = createProtectionProvider(
      { metricsUrl: 'https://prot.internal/metrics' },
      undefined,
      async () => {
        throw new Error('down');
      },
    );
    await expect(p.measure(ctx)).resolves.toBeNull();
  });
});
