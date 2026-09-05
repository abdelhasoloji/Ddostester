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
});
