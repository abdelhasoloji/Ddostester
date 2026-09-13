import { describe, it, expect } from 'vitest';
import { suggestFromRecon } from './recon-first-create.js';
import type { ReconReport } from './api.js';

const base = (over: Partial<ReconReport>): ReconReport =>
  ({
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    generatedAt: '',
    profile: { posture: {}, cache: 'unknown' },
    baseline: { availabilityPct: 100, latencyP95: 20 },
    preflight: { items: [], go: true },
    seededProfile: {},
    suggestedPaths: ['/'],
    ...over,
  }) as unknown as ReconReport;

describe('suggestFromRecon (E15)', () => {
  it('seeds the dynamic paths as the endpoint mix', () => {
    const s = suggestFromRecon(
      base({
        dynamicPaths: ['/api/search', '/login'],
        suggestedPaths: ['/', '/api/search', '/login', '/about'],
      }),
    );
    expect(s.initial.endpoints).toContain('https://bank.cz/api/search');
    expect(s.initial.endpoints).toContain('https://bank.cz/login');
    expect(s.rationale.join(' ')).toMatch(/dynamic ⚡/);
  });

  it('picks POST when a login path was found', () => {
    const s = suggestFromRecon(base({ loginPath: '/login', dynamicPaths: ['/login'] }));
    expect(s.initial.vector).toBe('http-post');
    expect(s.rationale.join(' ')).toMatch(/login\/account path/);
  });

  it('turns cache-busting ON when the target serves from cache', () => {
    const cached = suggestFromRecon(base({ profile: { posture: {}, cache: 'hit' } as never }));
    expect(cached.initial.cacheBust).toBe(true);
    expect(cached.rationale.join(' ')).toMatch(/cache-busting ON/);
    const dynamic = suggestFromRecon(base({ profile: { posture: {}, cache: 'dynamic' } as never }));
    expect(dynamic.initial.cacheBust).toBe(false);
  });

  it('always carries the target through', () => {
    const s = suggestFromRecon(base({ target: 'https://bank.cz/' }));
    expect(s.initial.target).toBe('https://bank.cz/');
    expect(s.initial.probeUrl).toBe('https://bank.cz/');
  });
});
