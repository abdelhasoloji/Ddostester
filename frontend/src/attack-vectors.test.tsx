import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReconReport } from './api.js';
import { attackVectorsFromRecon, ReconDetailModal } from './recon-detail.js';

const base = (over: Partial<ReconReport>): ReconReport =>
  ({
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    generatedAt: '',
    profile: { posture: {}, cache: 'unknown', protocols: { http2: false, http3: false } },
    baseline: { availabilityPct: 100, latencyP95: 20 },
    preflight: { items: [], go: true },
    seededProfile: {},
    suggestedPaths: ['/'],
    ...over,
  }) as unknown as ReconReport;

const names = (r: ReconReport) => attackVectorsFromRecon(r).map((v) => v.vector);

describe('attackVectorsFromRecon (recon → what it opens)', () => {
  it('a cache HIT opens the cache-busted GET flood', () => {
    const v = attackVectorsFromRecon(base({ profile: { posture: {}, cache: 'hit' } as never }));
    const cb = v.find((x) => x.vector === 'Cache-busted GET flood');
    expect(cb).toBeTruthy();
    expect(cb!.signal).toBe('cache HIT');
  });

  it('a CDN (without a cache hit) also opens the cache-busted GET flood', () => {
    const v = attackVectorsFromRecon(
      base({ profile: { posture: { cdn: true }, cache: 'miss' } as never }),
    );
    const cb = v.find((x) => x.vector === 'Cache-busted GET flood');
    expect(cb).toBeTruthy();
    expect(cb!.signal).toBe('CDN');
  });

  it('dynamic paths open the L7 multi-vector, signalling the count', () => {
    const v = attackVectorsFromRecon(base({ dynamicPaths: ['/api/search', '/account'] }));
    const dyn = v.find((x) => x.vector === 'Dynamic-path L7 multi-vector');
    expect(dyn).toBeTruthy();
    expect(dyn!.signal).toContain('2 dynamic');
  });

  it('a login path opens the auth POST flood', () => {
    expect(names(base({ loginPath: '/wp-login.php' }))).toContain('Auth POST flood');
  });

  it('HTTP/2 opens the h2 request-path stress', () => {
    const v = base({ profile: { posture: {}, protocols: { http2: true } } as never });
    expect(names(v)).toContain('HTTP/2 request-path stress');
  });

  it('a rate-limiter opens the breaking-point probe; a WAF opens UA rotation', () => {
    const v = base({ profile: { posture: { waf: true, rateLimiting: true } } as never });
    const n = names(v);
    expect(n).toContain('Rate-limit breaking-point');
    expect(n).toContain('UA-rotation / signature evasion');
  });

  it('no load-balancer opens the connection-concurrency vector', () => {
    // Default posture has no loadBalancer flag → connection-concurrency applies.
    expect(names(base({}))).toContain('Connection-concurrency (slow-hold)');
    // With a load-balancer present it does NOT.
    const lb = base({ profile: { posture: { loadBalancer: true } } as never });
    expect(names(lb)).not.toContain('Connection-concurrency (slow-hold)');
  });

  it('a fully bare origin opens the direct volumetric vector', () => {
    // posture with no waf/cdn/rateLimiting → bare-origin direct volumetric.
    expect(names(base({}))).toContain('Direct volumetric (bare origin)');
    // Any edge protection suppresses it.
    const guarded = base({ profile: { posture: { waf: true } } as never });
    expect(names(guarded)).not.toContain('Direct volumetric (bare origin)');
  });

  it('a WEDOS-fronted WordPress (waf+cdn+rate-limit, cache hit, login, dynamic) opens the full set', () => {
    const v = attackVectorsFromRecon(
      base({
        profile: {
          posture: { waf: true, cdn: true, rateLimiting: true },
          cache: 'hit',
          protocols: { http2: true },
        } as never,
        dynamicPaths: ['/wp-login.php', '/?s=x'],
        loginPath: '/wp-login.php',
      }),
    );
    const n = v.map((x) => x.vector);
    expect(n).toEqual(
      expect.arrayContaining([
        'Cache-busted GET flood',
        'Dynamic-path L7 multi-vector',
        'Auth POST flood',
        'HTTP/2 request-path stress',
        'Rate-limit breaking-point',
        'UA-rotation / signature evasion',
      ]),
    );
    // An edge is present, so neither bare-origin vector appears.
    expect(n).not.toContain('Direct volumetric (bare origin)');
    expect(n).not.toContain('Connection-concurrency (slow-hold)');
    // Every hint carries a non-empty rationale and signal.
    for (const hint of v) {
      expect(hint.why.length).toBeGreaterThan(10);
      expect(hint.signal.length).toBeGreaterThan(0);
      expect(hint.drs.length).toBeGreaterThan(0);
    }
  });
});

const richRecon = (): ReconReport =>
  ({
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    generatedAt: new Date().toISOString(),
    profile: {
      posture: {
        waf: true,
        cdn: true,
        rateLimiting: true,
        loadBalancer: false,
        hsts: true,
        securityHeaders: ['content-security-policy'],
        server: 'LiteSpeed',
        signals: ['x-cdn-provider: wedos'],
      },
      vendor: 'WEDOS Protection',
      protocols: { http2: true, http3: false },
      tls: 'TLS 1.3',
      cache: 'hit',
      server: 'LiteSpeed',
    },
    surface: {
      paths: ['/', '/wp-login.php'],
      loginPath: '/wp-login.php',
      sitemaps: [],
      disallow: [],
    },
    baseline: { samples: 5, availabilityPct: 100, latencyP50: 30, latencyP95: 80, latencyMean: 40 },
    preflight: {
      items: [{ key: 'k', label: 'Allowlisted', ok: true, required: true, detail: '' }],
      go: true,
    },
    seededProfile: { rateLimiting: 'present' },
    suggestedPaths: ['/', '/wp-login.php'],
    dynamicPaths: ['/wp-login.php'],
    loginPath: '/wp-login.php',
  }) as unknown as ReconReport;

describe('ReconDetailModal — Attack vectors section', () => {
  it('renders the attack-vectors section with vector cards and closes', () => {
    const onClose = vi.fn();
    render(<ReconDetailModal recon={richRecon()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: /Target intelligence/ })).toBeInTheDocument();
    expect(screen.getByText('Attack vectors this surface opens')).toBeInTheDocument();
    // A representative vector card + its enabling signal appear.
    expect(screen.getByText('Cache-busted GET flood')).toBeInTheDocument();
    expect(screen.getByText('Auth POST flood')).toBeInTheDocument();
    expect(screen.getByText(/cache HIT/)).toBeInTheDocument();
    // Escape closes.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
