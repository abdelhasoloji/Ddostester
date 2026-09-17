import { describe, expect, it } from 'vitest';
import { recommendActions, type SuggestedAction } from '../src/modules/recon/actions.js';
import type { ReconReport, CacheBehavior } from '../src/modules/recon/recon.js';
import type { Playbook } from '../src/modules/playbooks/playbooks.js';
import { PLAYBOOKS } from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { HARD_CAPS } from '../src/config/limits.js';

/** Compact ReconReport fixture — the recommender reads only posture/protocols/
 *  cache/dynamicPaths/suggestedPaths/loginPath/vendor. */
function recon(over: {
  waf?: boolean;
  cdn?: boolean;
  http2?: boolean;
  cache?: CacheBehavior;
  vendor?: string;
  dynamicPaths?: string[];
  suggestedPaths?: string[];
  loginPath?: string;
}): ReconReport {
  const posture = {
    waf: over.waf ?? false,
    cdn: over.cdn ?? false,
    rateLimiting: false,
    loadBalancer: false,
    hsts: false,
    securityHeaders: [] as string[],
  };
  const dynamicPaths = over.dynamicPaths ?? [];
  const suggestedPaths = over.suggestedPaths ?? dynamicPaths;
  return {
    target: 'http://t/',
    probeUrl: 'http://t/',
    generatedAt: '',
    profile: {
      posture,
      vendor: over.vendor,
      protocols: { http2: over.http2 ?? false, http3: false },
      cache: over.cache ?? 'unknown',
    },
    surface: {
      paths: suggestedPaths,
      dynamicPaths,
      loginPath: over.loginPath,
      sitemaps: [],
      disallow: [],
    },
    baseline: { samples: 5, availabilityPct: 100, latencyP50: 10, latencyP95: 20, latencyMean: 12 },
    preflight: { items: [], go: true },
    seededProfile: {},
    suggestedPaths,
    dynamicPaths,
    loginPath: over.loginPath,
  } as unknown as ReconReport;
}

const ENGINES = [
  { id: 'builtin', available: true },
  { id: 'vegeta', available: true },
  { id: 'k6', available: true },
];
const baseOpts = {
  engines: ENGINES,
  caps: HARD_CAPS,
  target: 'http://t/',
  probeUrl: 'http://t/',
};

/** A one-step template requiring `requires`. */
const pb = (id: string, requires: Playbook['requires'], drs = 3, maxRps = 300): Playbook =>
  ({
    id,
    name: id,
    category: 'Test',
    summary: `${id} summary`,
    when: '',
    drsLevel: drs,
    requires,
    steps: [
      {
        name: `${id} peak`,
        summary: '',
        maxRps,
        concurrency: 100,
        maxDurationSec: 60,
        profile: 'constant',
        vector: 'http-get',
      },
    ],
  }) as unknown as Playbook;

// Distinct maxRps so each produces a distinct seed (real templates differ; the
// dedupe would otherwise legitimately collapse identical lines).
const MINI: Playbook[] = [
  pb('dyn', ['dynamic'], 3, 300),
  pb('waf', ['waf'], 3, 350),
  pb('cache', ['cache'], 3, 250),
  pb('h2', ['h2'], 3, 200),
  pb('generic', undefined, 3, 150),
];

const byId = (as: SuggestedAction[], id: string) => as.find((a) => a.id === id)!;

describe('recommendActions — applicability & ranking', () => {
  it('bare origin (dynamic path, no waf/cache/h2): the dynamic line ranks top; waf/cache/h2 are N/A', () => {
    const as = recommendActions(recon({ dynamicPaths: ['/api/work.php'] }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    const top = as.filter((a) => a.id !== 'baseline')[0];
    expect(top.id).toBe('dyn');
    expect(top.applicable).toBe(true);
    for (const id of ['waf', 'cache', 'h2']) {
      const a = byId(as, id);
      expect(a.applicable).toBe(false);
      expect(a.naReasons).toContain(id === 'h2' ? 'h2' : id);
    }
    expect(byId(as, 'generic').applicable).toBe(true);
  });

  it('WAF target: the waf line becomes applicable and is boosted above a generic line', () => {
    const as = recommendActions(recon({ waf: true, dynamicPaths: ['/api'] }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    expect(byId(as, 'waf').applicable).toBe(true);
    expect(byId(as, 'waf').relevance).toBeGreaterThan(byId(as, 'generic').relevance);
  });

  it('cache target → cache line applicable; h2 target → h2 line applicable', () => {
    const cacheAs = recommendActions(recon({ cache: 'hit' }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    expect(byId(cacheAs, 'cache').applicable).toBe(true);
    expect(byId(cacheAs, 'dyn').applicable).toBe(false); // no dynamic path

    const h2As = recommendActions(recon({ http2: true }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    expect(byId(h2As, 'h2').applicable).toBe(true);
  });

  it('a baseline action is always present, for every posture', () => {
    for (const r of [
      recon({}),
      recon({ dynamicPaths: ['/api'] }),
      recon({ waf: true }),
      recon({ cache: 'hit' }),
      recon({ http2: true }),
    ]) {
      const as = recommendActions(r, { ...baseOpts, catalogue: MINI });
      const base = byId(as, 'baseline');
      expect(base).toBeTruthy();
      expect(base.applicable).toBe(true);
      expect(base.requires).toEqual([]);
    }
  });

  it('every applicable action outranks every N/A action', () => {
    const as = recommendActions(recon({ dynamicPaths: ['/api'] }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    const appl = as.filter((a) => a.applicable).map((a) => a.relevance);
    const na = as.filter((a) => !a.applicable).map((a) => a.relevance);
    if (na.length) expect(Math.min(...appl)).toBeGreaterThan(Math.max(...na));
  });

  it('rationale names the matched signal (applicable) or the missing feature (N/A)', () => {
    const as = recommendActions(recon({ waf: true, vendor: 'WEDOS', cache: 'miss' }), {
      ...baseOpts,
      catalogue: MINI,
      topN: 10,
    });
    expect(byId(as, 'waf').rationale.join(' ')).toMatch(/WAF/i);
    expect(byId(as, 'cache').rationale.join(' ')).toMatch(/N\/A/);
  });
});

describe('recommendActions — over the real catalogue', () => {
  it('seeds are clamped to a tightened operational cap and pass createCampaign', () => {
    const caps = { maxRps: 50, maxConcurrency: 40, maxDurationSec: 90 };
    const as = recommendActions(
      recon({ dynamicPaths: ['/api/work.php'], waf: true, cache: 'hit', http2: true }),
      {
        ...baseOpts,
        catalogue: PLAYBOOKS,
        caps,
      },
    );
    for (const a of as) {
      expect(a.seed.maxRps).toBeLessThanOrEqual(caps.maxRps);
      expect(a.seed.concurrency).toBeLessThanOrEqual(caps.maxConcurrency);
      expect(a.seed.maxDurationSec).toBeLessThanOrEqual(caps.maxDurationSec);
      const scenTotal = (a.seed.scenario ?? []).reduce((n, p) => n + p.durationSec, 0);
      expect(scenTotal).toBeLessThanOrEqual(caps.maxDurationSec);
      // A clamped seed is a valid, governed campaign input.
      expect(() => createCampaign(a.seed, ['t'], undefined, caps)).not.toThrow();
    }
  });

  it('dedupes, caps to topN (+baseline) and spreads across categories', () => {
    const as = recommendActions(recon({ dynamicPaths: ['/api/work.php'] }), {
      ...baseOpts,
      catalogue: PLAYBOOKS,
      topN: 8,
    });
    expect(as.length).toBeLessThanOrEqual(9); // topN + forced baseline
    expect(as.some((a) => a.id === 'baseline')).toBe(true);
    // No two actions collapse to the same delivery signature.
    const sigs = as.map((a) =>
      [
        a.seed.vector,
        a.seed.maxRps,
        (a.seed.endpoints ?? []).map((e) => e.url).join(','),
        !!a.seed.cacheBust,
        !!a.seed.noKeepAlive,
      ].join('|'),
    );
    expect(new Set(sigs).size).toBe(sigs.length);
    // More than one category represented (the real catalogue has several).
    expect(new Set(as.map((a) => a.category)).size).toBeGreaterThan(1);
  });
});
