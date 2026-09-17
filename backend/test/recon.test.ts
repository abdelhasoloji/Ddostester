import { describe, expect, it } from 'vitest';
import {
  detectVendor,
  detectProtocols,
  detectCache,
  buildTargetProfile,
  profileToProtectionProfile,
  parseRobots,
  parseSitemapUrls,
  extractPaths,
  pickLoginPath,
  pathCost,
  buildSurface,
  computeBaseline,
  preflight,
  assembleReconReport,
  reconPostureSnapshot,
  type PreflightInput,
  type ReconReport,
} from '../src/modules/recon/recon.js';

describe('target profile (A)', () => {
  it('detects vendor, protocols and cache from headers', () => {
    const snaps = [
      {
        'cf-ray': 'abc',
        server: 'cloudflare',
        'alt-svc': 'h3=":443"; ma=86400, h2=":443"',
        'cf-cache-status': 'HIT',
      },
    ];
    const profile = buildTargetProfile(snaps, [200]);
    expect(profile.vendor).toBe('Cloudflare');
    expect(profile.protocols).toEqual({ http2: true, http3: true });
    expect(profile.cache).toBe('hit');
    expect(profile.posture.cdn).toBe(true);
  });

  it('detectVendor/detectCache degrade to undefined/unknown', () => {
    expect(
      detectVendor({
        waf: false,
        cdn: false,
        rateLimiting: false,
        loadBalancer: false,
        hsts: false,
        securityHeaders: [],
        signals: [],
      }),
    ).toBeUndefined();
    expect(detectCache([{}])).toBe('unknown');
    expect(detectProtocols([{}])).toEqual({ http2: false, http3: false });
    expect(detectProtocols([{}], 'h2').http2).toBe(true);
  });

  it('seeds the gap-analyzer profile from observed posture (E)', () => {
    const profile = buildTargetProfile([{ 'x-ratelimit-limit': '100', 'cf-ray': 'x' }], [200]);
    const seeded = profileToProtectionProfile(profile);
    expect(seeded.rateLimiting).toBe('present');
    expect(seeded.wafSignatures).toBe('present'); // cf-ray → waf
  });
});

describe('published-surface map (B)', () => {
  it('parses robots directives and sitemap locs', () => {
    const robots = parseRobots(
      'User-agent: *\nDisallow: /admin\nAllow: /public\nSitemap: https://bank.cz/sitemap.xml\n# comment',
    );
    expect(robots.disallow).toContain('/admin');
    expect(robots.allow).toContain('/public');
    expect(robots.sitemaps).toContain('https://bank.cz/sitemap.xml');
    expect(parseSitemapUrls('<url><loc>https://bank.cz/login</loc></url>')).toEqual([
      'https://bank.cz/login',
    ]);
  });

  it('extracts same-host paths and picks a login path', () => {
    const html =
      '<a href="/account">a</a><a href="https://bank.cz/login">l</a><a href="https://evil.example/x">e</a><a href="mailto:x@y">m</a>';
    const paths = extractPaths(html, 'bank.cz');
    expect(paths).toContain('/account');
    expect(paths).toContain('/login');
    expect(paths).not.toContain('/x'); // off-host dropped
    expect(pickLoginPath(paths)).toBe('/account'); // first login-like wins
  });

  it('builds a capped surface, respects Disallow, always includes root', () => {
    const surface = buildSurface({
      robots: 'Disallow: /secret',
      homepageHtml: '<a href="/a">a</a><a href="/secret/x">s</a><a href="/login">l</a>',
      host: 'bank.cz',
    });
    expect(surface.paths[0]).toBe('/');
    expect(surface.paths).toContain('/a');
    expect(surface.paths).not.toContain('/secret/x'); // disallowed
    expect(surface.loginPath).toBe('/login');
  });

  it('scores dynamic/expensive paths above static assets (pathCost, P1)', () => {
    expect(pathCost('/api/search?q=1')).toBeGreaterThan(pathCost('/assets/app.js'));
    expect(pathCost('/login')).toBeGreaterThan(pathCost('/style.css'));
    expect(pathCost('/static/logo.png')).toBeLessThan(0);
    expect(pathCost('/wp-login.php')).toBeGreaterThan(0);
  });

  it('ranks dynamic paths ahead of static assets in the surface (P1)', () => {
    const surface = buildSurface({
      homepageHtml:
        '<a href="/assets/app.js">j</a><a href="/style.css">c</a>' +
        '<a href="/api/search?q=1">s</a><a href="/login">l</a><a href="/about">a</a>',
      host: 'bank.cz',
    });
    expect(surface.paths[0]).toBe('/'); // root anchor stays first
    const iApi = surface.paths.indexOf('/api/search?q=1');
    const iJs = surface.paths.indexOf('/assets/app.js');
    expect(iApi).toBeGreaterThan(0);
    expect(iApi).toBeLessThan(iJs); // dynamic ranked before static
    expect(surface.dynamicPaths).toContain('/api/search?q=1');
    expect(surface.dynamicPaths).toContain('/login');
    expect(surface.dynamicPaths).not.toContain('/assets/app.js');
  });
});

describe('baseline (C)', () => {
  it('summarises samples; empty is safe', () => {
    const b = computeBaseline([
      { ok: true, latencyMs: 10 },
      { ok: true, latencyMs: 20 },
      { ok: false, latencyMs: 30 },
      { ok: true, latencyMs: 40 },
    ]);
    expect(b.samples).toBe(4);
    expect(b.availabilityPct).toBe(75);
    expect(b.latencyP50).toBeGreaterThan(0);
    expect(computeBaseline([]).availabilityPct).toBe(0);
  });
});

describe('preflight (D)', () => {
  const base: PreflightInput = {
    targetAllowed: true,
    probeAllowed: true,
    probeReachable: true,
    enginesAvailable: 2,
    capsConfigured: true,
    protectionConfigured: true,
    labRunnerConfigured: true,
  };
  it('go is true when every required item passes', () => {
    expect(preflight(base).go).toBe(true);
  });
  it('a missing required item flips go to false', () => {
    expect(preflight({ ...base, targetAllowed: false }).go).toBe(false);
  });
  it('optional items (protection, lab runner) do not block go', () => {
    const pf = preflight({ ...base, protectionConfigured: false, labRunnerConfigured: false });
    expect(pf.go).toBe(true);
    expect(pf.items.find((i) => i.key === 'protection')!.ok).toBe(false);
  });
});

describe('assembleReconReport (E)', () => {
  it('ties profile, surface, baseline, preflight and seeding together', () => {
    const report = assembleReconReport({
      target: 'https://bank.cz/',
      probeUrl: 'https://bank.cz/health',
      headerSnapshots: [{ 'cf-ray': 'x', 'x-ratelimit-limit': '10' }],
      statuses: [200],
      host: 'bank.cz',
      robots: 'Disallow: /admin\nSitemap: https://bank.cz/sitemap.xml',
      homepageHtml: '<a href="/login">l</a><a href="/catalog">c</a>',
      baselineSamples: [{ ok: true, latencyMs: 12 }],
      preflightInput: {
        targetAllowed: true,
        probeAllowed: true,
        enginesAvailable: 1,
        capsConfigured: true,
        protectionConfigured: true,
        labRunnerConfigured: false,
      },
    });
    expect(report.profile.vendor).toBe('Cloudflare');
    expect(report.seededProfile.rateLimiting).toBe('present');
    expect(report.suggestedPaths).toContain('/login');
    expect(report.loginPath).toBe('/login');
    expect(report.preflight.go).toBe(true); // probeReachable derived from baseline
    expect(report.baseline.samples).toBe(1);
  });
});

describe('reconPostureSnapshot (single source of the posture→requirement mapping)', () => {
  const mk = (over: Record<string, unknown>): ReconReport =>
    ({
      profile: {
        posture: { waf: false, cdn: false },
        protocols: { http2: false, http3: false },
        cache: 'unknown',
        ...(over.profile as object),
      },
      dynamicPaths: (over.dynamicPaths as string[]) ?? [],
    }) as unknown as ReconReport;

  it('maps h2/waf/cache/dynamic exactly as the old inline formula did', () => {
    // Bare origin
    expect(reconPostureSnapshot(mk({}))).toEqual({
      h2: false,
      waf: false,
      cache: false,
      dynamic: false,
    });
    // WAF only
    expect(reconPostureSnapshot(mk({ profile: { posture: { waf: true, cdn: false } } })).waf).toBe(
      true,
    );
    // cache via cache==='hit' OR cdn
    expect(
      reconPostureSnapshot(mk({ profile: { cache: 'hit', posture: { cdn: false } } })).cache,
    ).toBe(true);
    expect(
      reconPostureSnapshot(mk({ profile: { cache: 'miss', posture: { cdn: true } } })).cache,
    ).toBe(true);
    expect(
      reconPostureSnapshot(mk({ profile: { cache: 'miss', posture: { cdn: false } } })).cache,
    ).toBe(false);
    // h2 from protocols.http2
    expect(
      reconPostureSnapshot(mk({ profile: { protocols: { http2: true, http3: false } } })).h2,
    ).toBe(true);
    // dynamic from any dynamic path
    expect(reconPostureSnapshot(mk({ dynamicPaths: ['/api'] })).dynamic).toBe(true);
    expect(reconPostureSnapshot(mk({ dynamicPaths: [] })).dynamic).toBe(false);
  });
});
