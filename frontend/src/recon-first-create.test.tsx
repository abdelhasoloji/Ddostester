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

const { suggestFromRecon, ReconFirstCreate } = await import('./recon-first-create.js');

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

  it('surfaces a recon error and stays on the target step', async () => {
    reconMock.mockRejectedValue(new Error('recon boom'));
    render(<ReconFirstCreate />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://bank.cz/' } });
    fireEvent.click(screen.getByRole('button', { name: /Run recon/i }));
    await waitFor(() => expect(screen.getByText('recon boom')).toBeInTheDocument());
  });
});
