import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp } from './test-utils.js';
import type { ReconReport } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
const reconMock = vi.fn();
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: { ...actual.api, recon: (...a: unknown[]) => reconMock(...a) } };
});

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
    reconMock.mockReset();
  });

  it('gates "Run recon" until the target is on the allowlist', () => {
    render(<ReconFirstCreate />);
    const btn = screen.getByRole('button', { name: /Run recon/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://evil.example/' } });
    expect(screen.getByRole('button', { name: /Run recon/i })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    expect(screen.getByRole('button', { name: /Run recon/i })).toBeEnabled();
  });

  it('runs recon and shows the suggestion derived from the findings', async () => {
    reconMock.mockResolvedValue(
      base({
        profile: { posture: { server: 'LiteSpeed', rateLimiting: true }, cache: 'hit' } as never,
        dynamicPaths: ['/login'],
        suggestedPaths: ['/', '/login'],
        loginPath: '/login',
      }),
    );
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Run recon/i }));
    await waitFor(() => expect(screen.getByText(/Suggested campaign/)).toBeInTheDocument());
    expect(screen.getByText(/cache-busting ON/)).toBeInTheDocument();
    expect(screen.getAllByText(/LiteSpeed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/preflight GO/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Compose from these findings/i }),
    ).toBeInTheDocument();
  });

  it('renders recon-recommended levers pre-checked and lets the operator toggle them', async () => {
    reconMock.mockResolvedValue(
      base({
        profile: {
          posture: { server: 'LiteSpeed', waf: true, cdn: true, rateLimiting: true },
          cache: 'hit',
        } as never,
      }),
    );
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Run recon/i }));
    await waitFor(() => expect(screen.getByText(/Delivery levers/)).toBeInTheDocument());

    // The three WEDOS-signalled levers are pre-checked; no-keep-alive is optional/off.
    const cacheBust = screen.getByRole('checkbox', { name: /Cache-busting/i });
    const calibrate = screen.getByRole('checkbox', { name: /Auto-calibrate rate/i });
    const rotateUa = screen.getByRole('checkbox', { name: /User-Agent rotation/i });
    const noKa = screen.getByRole('checkbox', { name: /No keep-alive/i });
    expect(cacheBust).toBeChecked();
    expect(calibrate).toBeChecked();
    expect(rotateUa).toBeChecked();
    expect(noKa).not.toBeChecked();
    // The recon rationale is shown on the recommended levers.
    expect(screen.getByText(/recon: rate-limiter seen/)).toBeInTheDocument();
    expect(screen.getByText(/recon: WAF detected/)).toBeInTheDocument();

    // The operator can drop a lever and add an optional one.
    fireEvent.click(calibrate);
    fireEvent.click(noKa);
    expect(calibrate).not.toBeChecked();
    expect(noKa).toBeChecked();

    // Composing carries the choices into the launch form.
    fireEvent.click(screen.getByRole('button', { name: /Compose from these findings/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Submit for approval/i })).toBeInTheDocument(),
    );
  });

  it('lets the operator deselect a discovered path so it leaves the endpoint mix', async () => {
    reconMock.mockResolvedValue(
      base({
        target: 'https://bank.cz/',
        suggestedPaths: ['/', '/api/search', '/login'],
        dynamicPaths: ['/api/search', '/login'],
      }),
    );
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Run recon/i }));
    await waitFor(() => expect(screen.getByText(/Discovered surface/)).toBeInTheDocument());

    // Both dynamic paths are pre-selected.
    const login = screen.getByRole('checkbox', { name: /\/login/ });
    const search = screen.getByRole('checkbox', { name: /\/api\/search/ });
    expect(login).toBeChecked();
    expect(search).toBeChecked();

    // Deselect /login → compose → the endpoint mix keeps /api/search but drops /login.
    fireEvent.click(login);
    expect(login).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /Compose from these findings/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Submit for approval/i })).toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue('https://bank.cz/api/search')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/\/login/)).toBeNull();
  });

  it('surfaces a recon error and stays on the target step', async () => {
    reconMock.mockRejectedValue(new Error('recon boom'));
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Run recon/i }));
    await waitFor(() => expect(screen.getByText('recon boom')).toBeInTheDocument());
  });
});
