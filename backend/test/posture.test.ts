import { describe, expect, it } from 'vitest';
import { analyzePosture } from '../src/modules/posture/analyze.js';

describe('analyzePosture', () => {
  it('detects a WAF/CDN from cf-ray and server header', () => {
    const r = analyzePosture([{ 'cf-ray': 'abc', server: 'cloudflare' }], [200]);
    expect(r.waf).toBe(true);
    expect(r.cdn).toBe(true);
    expect(r.server).toBe('cloudflare');
  });

  it('detects rate limiting from a 429 and from headers', () => {
    expect(analyzePosture([{}], [200, 429]).rateLimiting).toBe(true);
    expect(analyzePosture([{ 'x-ratelimit-limit': '100' }], [200]).rateLimiting).toBe(true);
  });

  it('detects a load balancer from an affinity cookie', () => {
    const r = analyzePosture([{ 'set-cookie': 'AWSALB=xyz; Path=/' }], [200]);
    expect(r.loadBalancer).toBe(true);
  });

  it('collects HSTS and hardening headers', () => {
    const r = analyzePosture(
      [
        {
          'strict-transport-security': 'max-age=63072000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
        },
      ],
      [200],
    );
    expect(r.hsts).toBe(true);
    expect(r.securityHeaders).toContain('content-security-policy');
    expect(r.securityHeaders).toContain('x-content-type-options');
  });

  it('is case-insensitive on header names', () => {
    const r = analyzePosture([{ 'CF-RAY': 'x', Server: 'cloudflare' }], [200]);
    expect(r.waf).toBe(true);
  });

  it('reports nothing on bare responses', () => {
    const r = analyzePosture([{ 'content-type': 'text/html' }], [200]);
    expect(r.waf).toBe(false);
    expect(r.cdn).toBe(false);
    expect(r.rateLimiting).toBe(false);
    expect(r.loadBalancer).toBe(false);
    expect(r.securityHeaders).toEqual([]);
  });

  // The proving ground must recognise its OWN product. WEDOS Global Protection
  // advertises itself by dedicated headers AND by product name in their values;
  // both must be detected so a WEDOS-fronted origin is never mis-read as bare.
  it('detects WEDOS Global Protection (WAF + CDN + rate-limit) from real bank.cz headers', () => {
    const r = analyzePosture(
      [
        {
          server: 'LiteSpeed', // the origin is still a bare LiteSpeed underneath
          'x-waf-protected-by': 'WEDOS Protection (WEDOS.protection)',
          'x-protected-by': 'WEDOS Global Protection (WEDOS.protection)',
          'x-cdn-provider': 'WEDOS Global CDN (WEDOS.delivery)',
          'x-cdn-cache-status': 'HIT',
          'x-rate-limit': '67/0/0',
          'x-location': 'ac30-HnV-dc2',
        },
      ],
      [200],
    );
    expect(r.waf).toBe(true);
    expect(r.cdn).toBe(true);
    expect(r.rateLimiting).toBe(true); // x-rate-limit
    expect(r.server).toBe('LiteSpeed'); // origin still surfaced, not masked
    expect(r.signals.join(' ')).toMatch(/WEDOS Protection/);
  });

  it('detects WEDOS by header VALUE even when the key is not enumerated', () => {
    // A bare x-provider whose key we don't list, but whose value names the product.
    const r = analyzePosture(
      [{ 'x-provider': 'WEDOS - WE DO Security (WEDOS.com)', 'x-cdn-by': 'WEDOS.delivery' }],
      [200],
    );
    expect(r.cdn).toBe(true);
  });

  it('a bare LiteSpeed origin (the 2026-09-12 baseline) still reports no protection', () => {
    // Before WEDOS was seated in front: LiteSpeed + WP headers only, no edge.
    const r = analyzePosture(
      [{ server: 'LiteSpeed', 'x-turbo-charged-by': 'LiteSpeed', 'content-type': 'text/html' }],
      [200],
    );
    expect(r.waf).toBe(false);
    expect(r.cdn).toBe(false);
    expect(r.rateLimiting).toBe(false);
  });
});
