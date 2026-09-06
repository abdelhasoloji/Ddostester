import { describe, expect, it } from 'vitest';
import {
  createTargetTelemetryProvider,
  noopTargetTelemetryProvider,
  parseTargetSample,
  summarizeTargetTelemetry,
  targetTelemetryConfigFromEnv,
} from '../src/modules/target-telemetry/provider.js';
import type { TargetSample } from '../src/modules/target-telemetry/types.js';

const ctx = { campaignId: 'c1', target: 'http://127.0.0.1/' };

describe('parseTargetSample', () => {
  it('accepts a payload with at least one metric', () => {
    const s = parseTargetSample({ cpuPct: 55, conntrack: 1200 }, '2026-01-01T00:00:00Z');
    expect(s).toMatchObject({ cpuPct: 55, conntrack: 1200, at: '2026-01-01T00:00:00Z' });
  });
  it('drops negative/non-numeric fields and returns null when nothing is left', () => {
    expect(parseTargetSample({ cpuPct: -1, conntrack: 'x' })).toBeNull();
    expect(parseTargetSample(null)).toBeNull();
    expect(parseTargetSample({ unrelated: 5 })).toBeNull();
  });
});

describe('targetTelemetryConfigFromEnv', () => {
  it('reads the metrics URL', () => {
    const cfg = targetTelemetryConfigFromEnv({
      TARGET_TELEMETRY_METRICS_URL: 'https://lab.internal/metrics',
    } as NodeJS.ProcessEnv);
    expect(cfg.metricsUrl).toBe('https://lab.internal/metrics');
  });
  it('reads the mock with defaults', () => {
    const cfg = targetTelemetryConfigFromEnv({
      TARGET_TELEMETRY_MOCK: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.mock).toMatchObject({ cpuPct: 40, conntrack: 1000 });
  });
});

describe('createTargetTelemetryProvider', () => {
  it('is the no-op provider when nothing is configured', () => {
    const p = createTargetTelemetryProvider({});
    expect(p).toBe(noopTargetTelemetryProvider);
    expect(p.configured).toBe(false);
  });

  it('rejects a non-http metrics URL', () => {
    expect(() => createTargetTelemetryProvider({ metricsUrl: 'ftp://x' })).toThrow(/http/);
  });

  it('mock provider returns the configured sample', async () => {
    const p = createTargetTelemetryProvider({ mock: { at: '', cpuPct: 30, conntrack: 500 } });
    expect(p.configured).toBe(true);
    const s = await p.sample(ctx);
    expect(s).toMatchObject({ cpuPct: 30, conntrack: 500 });
    expect(s?.at).not.toBe('');
  });

  it('poll provider GETs the metrics endpoint with the run context', async () => {
    let seen = '';
    const p = createTargetTelemetryProvider(
      { metricsUrl: 'https://lab.internal/metrics' },
      async (url) => {
        seen = url;
        return { cpuPct: 88, nicRxMbps: 120 };
      },
    );
    const s = await p.sample(ctx);
    expect(s).toMatchObject({ cpuPct: 88, nicRxMbps: 120 });
    const u = new URL(seen);
    expect(u.searchParams.get('campaignId')).toBe('c1');
    expect(u.searchParams.get('target')).toBe('http://127.0.0.1/');
  });

  it('never throws — a failing source yields null', async () => {
    const p = createTargetTelemetryProvider(
      { metricsUrl: 'https://lab.internal/metrics' },
      async () => {
        throw new Error('down');
      },
    );
    await expect(p.sample(ctx)).resolves.toBeNull();
  });
});

describe('summarizeTargetTelemetry', () => {
  it('reports the peak of each present metric', () => {
    const series: TargetSample[] = [
      { at: 't1', cpuPct: 30, conntrack: 800 },
      { at: 't2', cpuPct: 70, conntrack: 1500, nicRxMbps: 90 },
    ];
    expect(summarizeTargetTelemetry(series)).toEqual({
      samples: 2,
      cpuPctMax: 70,
      conntrackMax: 1500,
      nicRxMbpsMax: 90,
      nicTxMbpsMax: undefined,
    });
  });
  it('handles an empty series', () => {
    expect(summarizeTargetTelemetry([])).toEqual({
      samples: 0,
      cpuPctMax: undefined,
      conntrackMax: undefined,
      nicRxMbpsMax: undefined,
      nicTxMbpsMax: undefined,
    });
  });
});
