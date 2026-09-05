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
});
