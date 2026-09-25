import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, renderWithRouter } from './test-utils.js';
import type { ReconReport, SuggestedAction, ReconWithActions, ActionSeed } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
const reconActionsMock = vi.fn();
const composeActionsMock = vi.fn();
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      reconActions: (...a: unknown[]) => reconActionsMock(...a),
      composeActions: (...a: unknown[]) => composeActionsMock(...a),
    },
  };
});

/** Build a ReconWithActions payload from a base report + a list of actions. */
const withActions = (report: ReconReport, actions: SuggestedAction[]): ReconWithActions =>
  ({ ...report, actions }) as ReconWithActions;

const action = (
  id: string,
  title: string,
  over: Omit<Partial<SuggestedAction>, 'seed'> & { seed?: Partial<ActionSeed> } = {},
): SuggestedAction =>
  ({
    id,
    title,
    summary: `${title} summary`,
    rationale: ['recon says so'],
    applicable: true,
    relevance: 1000,
    ...over,
    seed: {
      name: title,
      target: 'https://bank.cz/',
      probeUrl: 'https://bank.cz/',
      vector: 'http-get',
      maxRps: 100,
      concurrency: 50,
      maxDurationSec: 60,
      authorized: true,
      ...(over.seed ?? {}),
    },
  }) as unknown as SuggestedAction;

const {
  suggestFromRecon,
  deriveLevers,
  applyLevers,
  discoveredPaths,
  defaultSelectedPaths,
  endpointsFromPaths,
  DEFAULT_UAS,
  ReconFirstCreate,
} = await import('./recon-first-create.js');

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

describe('deriveLevers (recon signal → recommended delivery lever)', () => {
  const on = (levers: ReturnType<typeof deriveLevers>, id: string) =>
    levers.find((l) => l.id === id)!;

  it('recommends the WEDOS stack levers from a fronted origin (WAF+CDN+rate-limit)', () => {
    const levers = deriveLevers(
      base({
        profile: {
          posture: { server: 'LiteSpeed', waf: true, cdn: true, rateLimiting: true },
          cache: 'hit',
        } as never,
      }),
    );
    expect(on(levers, 'cacheBust').recommended).toBe(true); // CDN cache HIT
    expect(on(levers, 'cacheBust').signal).toMatch(/CDN cache/);
    expect(on(levers, 'calibrate').recommended).toBe(true); // rate-limiter
    expect(on(levers, 'calibrate').signal).toMatch(/rate-limiter/);
    expect(on(levers, 'rotateUa').recommended).toBe(true); // WAF
    expect(on(levers, 'rotateUa').signal).toMatch(/WAF/);
    // no-keep-alive is always optional (no recon signal), off by default.
    expect(on(levers, 'noKeepAlive').recommended).toBe(false);
    expect(on(levers, 'noKeepAlive').signal).toBeNull();
  });

  it('recommends nothing for a bare origin (all posture false, no cache)', () => {
    const levers = deriveLevers(base({ profile: { posture: {}, cache: 'dynamic' } as never }));
    expect(levers.every((l) => l.recommended === false)).toBe(true);
    // Every lever still carries a plain-language "why".
    expect(levers.every((l) => l.why.length > 10)).toBe(true);
  });
});

describe('recon-discovered path selection', () => {
  it('lists the discovered surface, dynamic paths first, de-duplicated, root dropped', () => {
    const paths = discoveredPaths(
      base({
        suggestedPaths: ['/', '/about', '/api/search', '/login'],
        dynamicPaths: ['/api/search', '/login'],
      }),
    );
    // Root dropped; dynamic (/api/search, /login) sorted before static (/about).
    expect(paths.map((p) => p.path)).toEqual(['/api/search', '/login', '/about']);
    expect(paths.filter((p) => p.dynamic).map((p) => p.path)).toEqual(['/api/search', '/login']);
  });

  it('pre-selects the dynamic paths when present (else non-root suggested, max 10)', () => {
    expect(
      defaultSelectedPaths(
        base({ dynamicPaths: ['/a', '/b'], suggestedPaths: ['/', '/a', '/b', '/c'] }),
      ),
    ).toEqual(['/a', '/b']);
    expect(defaultSelectedPaths(base({ suggestedPaths: ['/', '/x', '/y'] }))).toEqual(['/x', '/y']);
  });

  it('builds the endpoint mix from the selected paths against the target origin', () => {
    const eps = endpointsFromPaths(base({ target: 'https://bank.cz/' }), ['/api/search', '/login']);
    expect(eps).toBe('https://bank.cz/api/search\nhttps://bank.cz/login');
  });
});

describe('applyLevers (toggles → form seed)', () => {
  const off = { cacheBust: false, calibrate: false, rotateUa: false, noKeepAlive: false };

  it('threads the boolean levers into the form config', () => {
    const seed = applyLevers(
      { target: 'https://bank.cz/' },
      { ...off, cacheBust: true, calibrate: true, noKeepAlive: true },
    );
    expect(seed.cacheBust).toBe(true);
    expect(seed.calibrate).toBe(true);
    expect(seed.noKeepAlive).toBe(true);
    expect(seed.target).toBe('https://bank.cz/'); // base preserved
  });

  it('seeds the User-Agent list only when UA rotation is on', () => {
    expect(applyLevers({}, { ...off, rotateUa: true }).userAgents).toBe(DEFAULT_UAS.join('\n'));
    expect(applyLevers({}, off).userAgents).toBe('');
  });
});

describe('ReconFirstCreate (recon-first flow)', () => {
  beforeEach(() => {
    currentApp = makeApp({ allowed: ['bank.cz'] });
    reconActionsMock.mockReset();
    composeActionsMock.mockReset();
  });

  it('gates "Profile target" until the target is on the allowlist', () => {
    render(<ReconFirstCreate />);
    const btn = screen.getByRole('button', { name: /Profile target/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://evil.example/' } });
    expect(screen.getByRole('button', { name: /Profile target/i })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    expect(screen.getByRole('button', { name: /Profile target/i })).toBeEnabled();
  });

  it('runs recon and shows the ranked recommended actions', async () => {
    reconActionsMock.mockResolvedValue(
      withActions(base({ profile: { posture: { server: 'LiteSpeed' }, cache: 'hit' } as never }), [
        action('dyn', 'Bare-origin L7 exhaustion', { requires: ['dynamic'], drs: 3 }),
        action('baseline', 'Baseline — pre-load health'),
      ]),
    );
    renderWithRouter(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText(/Recommended actions/)).toBeInTheDocument());
    expect(screen.getByText('Bare-origin L7 exhaustion')).toBeInTheDocument();
    expect(screen.getByText('needs dynamic endpoint')).toBeInTheDocument();
    expect(screen.getAllByText(/LiteSpeed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/preflight GO/)).toBeInTheDocument();
  });

  it('re-runs recon on the same target from the results view', async () => {
    reconActionsMock.mockResolvedValue(
      withActions(base({ profile: { posture: { server: 'LiteSpeed' } } as never }), [
        action('baseline', 'Baseline — pre-load health'),
      ]),
    );
    renderWithRouter(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText(/Recommended actions/)).toBeInTheDocument());
    expect(reconActionsMock).toHaveBeenCalledTimes(1);
    // The results view offers a re-run that re-profiles the same target.
    fireEvent.click(screen.getByRole('button', { name: /Re-run recon/i }));
    await waitFor(() => expect(reconActionsMock).toHaveBeenCalledTimes(2));
    expect(reconActionsMock.mock.calls[1][0]).toBe('https://bank.cz/');
  });

  it('selects actions and composes them into a governed campaign', async () => {
    reconActionsMock.mockResolvedValue(
      withActions(base({}), [
        action('dyn', 'GET flood', { requires: ['dynamic'], seed: { maxRps: 300 } }),
        action('baseline', 'Baseline — pre-load health'),
      ]),
    );
    composeActionsMock.mockResolvedValue({ campaigns: [{}] });
    renderWithRouter(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText('GET flood')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('checkbox', { name: /Select GET flood/i }));
    fireEvent.click(screen.getByRole('button', { name: /Create campaign/i }));
    await waitFor(() => expect(composeActionsMock).toHaveBeenCalledTimes(1));
    const arg = composeActionsMock.mock.calls[0][0] as { campaigns: { name: string }[] };
    expect(arg.campaigns).toHaveLength(1);
    expect(arg.campaigns[0].name).toBe('GET flood');
    expect(currentApp.push).toHaveBeenCalledWith('success', expect.stringMatching(/created/i));
  });

  it('shows N/A actions separately and blocks selecting them', async () => {
    reconActionsMock.mockResolvedValue(
      withActions(base({}), [
        action('base', 'Baseline — pre-load health'),
        action('waf', 'L7 signature evasion', {
          applicable: false,
          requires: ['waf'],
          naReasons: ['waf'],
        }),
      ]),
    );
    renderWithRouter(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText(/Recommended actions/)).toBeInTheDocument());
    // The N/A action is listed under the reference disclosure and can't be picked.
    expect(screen.getByText(/not applicable to this target/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Select L7 signature evasion/i })).toBeDisabled();
  });

  it('opens one action in the full editor', async () => {
    reconActionsMock.mockResolvedValue(
      withActions(base({}), [action('dyn', 'GET flood', { requires: ['dynamic'] })]),
    );
    renderWithRouter(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText('GET flood')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Open in editor/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Submit for approval/i })).toBeInTheDocument(),
    );
  });

  it('surfaces a recon error and stays on the target step', async () => {
    reconActionsMock.mockRejectedValue(new Error('recon boom'));
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Profile target/i }));
    await waitFor(() => expect(screen.getByText('recon boom')).toBeInTheDocument());
  });
});
