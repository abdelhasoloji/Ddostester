import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReconReport } from './api.js';

let fakeApp: Record<string, unknown>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => fakeApp };
});

const recon = vi.fn();
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: { ...actual.api, recon } };
});

const { PreparationPage } = await import('./preparation-page.js');

const REPORT: ReconReport = {
  target: 'https://bank.cz/',
  probeUrl: 'https://bank.cz/',
  generatedAt: '2026-01-01T00:00:00Z',
  profile: {
    posture: {
      waf: true,
      cdn: true,
      rateLimiting: true,
      loadBalancer: false,
      hsts: true,
      securityHeaders: ['content-security-policy'],
      server: 'cloudflare',
      signals: ['header cf-ray'],
    },
    vendor: 'Cloudflare',
    protocols: { http2: true, http3: true },
    cache: 'hit',
    server: 'cloudflare',
  },
  surface: {
    paths: ['/', '/login', '/catalog'],
    loginPath: '/login',
    sitemaps: [],
    disallow: ['/admin'],
  },
  baseline: { samples: 5, availabilityPct: 100, latencyP50: 12, latencyP95: 30, latencyMean: 15 },
  preflight: {
    go: true,
    items: [
      {
        key: 'target-allowed',
        label: 'Target in ALLOWED_TARGETS',
        ok: true,
        required: true,
        detail: 'allowlisted',
      },
      {
        key: 'protection',
        label: 'Protection hook wired (measured TTD/TTM)',
        ok: false,
        required: false,
        detail: 'not wired — estimated',
      },
    ],
  },
  seededProfile: { rateLimiting: 'present', wafSignatures: 'present' },
  suggestedPaths: ['/', '/login', '/catalog'],
  loginPath: '/login',
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <PreparationPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  fakeApp = { push: vi.fn() };
  recon.mockResolvedValue(REPORT);
  sessionStorage.clear();
});

describe('PreparationPage', () => {
  it('runs recon and renders profile, preflight, surface and baseline', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Run recon/ }));
    await waitFor(() => expect(recon).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(/Go — ready to run/)).toBeInTheDocument();
    expect(screen.getByText('Cloudflare')).toBeInTheDocument(); // vendor
    expect(screen.getByText('optional')).toBeInTheDocument(); // non-required preflight item tag
    expect(screen.getByText('/login')).toBeInTheDocument(); // surface path chip
    expect(screen.getByText('100%')).toBeInTheDocument(); // baseline availability
  });

  it('shows the no-go banner when preflight fails', async () => {
    recon.mockResolvedValue({ ...REPORT, preflight: { go: false, items: REPORT.preflight.items } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Run recon/ }));
    await waitFor(() => expect(screen.getByText(/No-go/)).toBeInTheDocument());
  });

  it('surfaces an error through app.push when recon fails', async () => {
    recon.mockRejectedValue(new Error('not allowlisted'));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Run recon/ }));
    await waitFor(() => expect(fakeApp.push).toHaveBeenCalledWith('error', 'not allowlisted'));
  });

  it('hands the recon findings off to the Plan phase', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Run recon/ }));
    await screen.findByText(/Go — ready to run/);
    fireEvent.click(screen.getByRole('button', { name: /Send to Plan/ }));
    const handoff = JSON.parse(sessionStorage.getItem('shieldtest.reconHandoff') ?? '{}');
    expect(handoff.target).toBe('https://bank.cz/');
    expect(handoff.seededProfile.rateLimiting).toBe('present');
  });
});
