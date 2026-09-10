import { describe, it, expect } from 'vitest';
import { corroborate } from '../src/modules/edge-absorption/corroboration.js';
import {
  createEdgeAbsorptionProvider,
  edgeAbsorptionConfigFromEnv,
  noopEdgeAbsorptionProvider,
} from '../src/modules/edge-absorption/provider.js';

describe('corroborate', () => {
  it('agrees when the two sides are within tolerance', () => {
    const c = corroborate(0.77, { seen: 1000, blocked: 800, served: 200, source: 'scrubbing' });
    expect(c.edgeAbsorbedRatio).toBeCloseTo(0.8, 5);
    expect(c.ourAbsorbedRatio).toBe(0.77);
    expect(c.agreementDelta).toBeCloseTo(0.03, 5);
    expect(c.agrees).toBe(true);
    expect(c.source).toBe('scrubbing');
  });

  it('disagrees when the gap exceeds tolerance', () => {
    const c = corroborate(0.3, { seen: 1000, blocked: 850, served: 150 });
    expect(c.agrees).toBe(false);
    expect(c.agreementDelta).toBeCloseTo(0.55, 5);
    expect(c.source).toBe('edge');
  });

  it('is safe when the edge saw nothing', () => {
    const c = corroborate(0.5, { seen: 0, blocked: 0, served: 0 });
    expect(c.edgeAbsorbedRatio).toBe(0);
  });
});

describe('edge-absorption provider', () => {
  const ctx = {
    campaignId: 'c1',
    target: 'https://bank.cz',
    startedAt: 'a',
    finishedAt: 'b',
    tag: 'c1',
  };

  it('is a noop by default (no config)', async () => {
    const p = createEdgeAbsorptionProvider({});
    expect(p.configured).toBe(false);
    expect(await p.report(ctx)).toBeNull();
    expect(noopEdgeAbsorptionProvider.configured).toBe(false);
  });

  it('returns fixed counts in mock mode', async () => {
    const cfg = edgeAbsorptionConfigFromEnv({
      EDGE_ABSORPTION_MOCK: 'true',
      EDGE_ABSORPTION_MOCK_SEEN: '1000',
      EDGE_ABSORPTION_MOCK_BLOCKED: '900',
      EDGE_ABSORPTION_MOCK_SERVED: '100',
    } as NodeJS.ProcessEnv);
    const p = createEdgeAbsorptionProvider(cfg);
    expect(p.configured).toBe(true);
    const r = await p.report(ctx);
    expect(r).toEqual({
      seen: 1000,
      blocked: 900,
      rateLimited: undefined,
      served: 100,
      source: 'mock',
    });
  });

  it('GETs the metrics URL and parses the edge report', async () => {
    let calledUrl = '';
    const p = createEdgeAbsorptionProvider(
      { metricsUrl: 'https://edge.local/absorb' },
      async (url) => {
        calledUrl = url;
        return { seen: 500, blocked: 400, served: 100, source: 'waf' };
      },
    );
    const r = await p.report(ctx);
    expect(r?.seen).toBe(500);
    expect(r?.blocked).toBe(400);
    expect(r?.source).toBe('waf');
    expect(calledUrl).toContain('target=https');
    expect(calledUrl).toContain('tag=c1');
  });

  it('returns null on a malformed edge response', async () => {
    const p = createEdgeAbsorptionProvider({ metricsUrl: 'https://edge.local/x' }, async () => ({
      nope: true,
    }));
    expect(await p.report(ctx)).toBeNull();
  });
});
