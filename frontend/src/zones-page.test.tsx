import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { ZoneSummary } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi();

vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const { ZonesPage } = await import('./zones-page.js');

const zone = (over: Partial<ZoneSummary>): ZoneSummary => ({
  host: 'bank.cz',
  campaigns: 3,
  suites: 1,
  running: false,
  regression: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({});
});

describe('ZonesPage', () => {
  it('renders a card per protected zone with its posture', async () => {
    fakeApi.zones.mockResolvedValue([
      zone({
        host: 'bank.cz',
        lastWrs: 78,
        lastLevel: 'C',
        maxDrs: 5,
        lastAbsorbedPct: 96.4,
        running: true,
      }),
      zone({
        host: 'shop.eu',
        lastWrs: 91,
        lastLevel: 'A',
        running: false,
        campaigns: 2,
        suites: 0,
      }),
      zone({
        host: 'idle.eu',
        lastWrs: 40,
        lastLevel: 'D',
        maxDrs: 1,
        lastAbsorbedPct: 0,
      }),
    ]);
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByText(/bank\.cz/)).toBeInTheDocument();
    expect(screen.getByText(/shop\.eu/)).toBeInTheDocument();
    expect(screen.getByText('DRS 5')).toBeInTheDocument();
    expect(screen.getByText('96.4%')).toBeInTheDocument();
    // A 0% absorbed reading is spelled out so it is not mistaken for "no data".
    expect(screen.getByText(/0% · edge idle/)).toBeInTheDocument();
    // Status reflects posture: a running zone shows "testing", an A-grade "resilient".
    expect(screen.getByText(/● testing/)).toBeInTheDocument();
    expect(screen.getByText(/resilient/)).toBeInTheDocument();
  });

  it('opens a zone into its filtered campaigns', async () => {
    fakeApi.zones.mockResolvedValue([zone({ host: 'bank.cz', lastWrs: 78, lastLevel: 'C' })]);
    renderWithRouter(<ZonesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Open bank\.cz/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/campaigns?q=bank.cz');
  });

  it('shows an empty state when there are no zones', async () => {
    fakeApi.zones.mockResolvedValue([]);
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByText(/No protected zones yet/)).toBeInTheDocument());
  });

  it('distinguishes a load failure from an empty estate, and retries', async () => {
    fakeApi.zones.mockRejectedValueOnce(new Error('offline'));
    renderWithRouter(<ZonesPage />);
    // A failure must NOT read as "no zones yet".
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load protected zones/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No protected zones yet/)).not.toBeInTheDocument();
    // Retry re-fetches; this time it returns a zone.
    fakeApi.zones.mockResolvedValue([zone({ host: 'bank.cz', lastWrs: 78, lastLevel: 'C' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/bank\.cz/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load protected zones/)).not.toBeInTheDocument();
  });
});

describe('Protected targets panel', () => {
  it('lists env-allowlisted (legacy) hosts as read-only rows in the table', async () => {
    fakeApi.zones.mockResolvedValue([]);
    fakeApi.targets.mockResolvedValue({
      targets: [],
      envAllowlist: ['bank.cz', '46.28.109.92'],
    });
    renderWithRouter(<ZonesPage />);
    // Both legacy hosts show, badged as permanently allowlisted…
    expect(await screen.findByText('bank.cz')).toBeInTheDocument();
    expect(screen.getByText('46.28.109.92')).toBeInTheDocument();
    expect(screen.getAllByText(/env-allowlisted/)).toHaveLength(2);
    // …and the panel does NOT read as empty when only env hosts exist.
    expect(screen.queryByText(/No targets registered yet/)).not.toBeInTheDocument();
  });

  it('does not duplicate a host that is both env-allowlisted and onboarded', async () => {
    fakeApi.zones.mockResolvedValue([]);
    fakeApi.targets.mockResolvedValue({
      targets: [
        { id: 't1', host: 'bank.cz', authStatus: 'authorized', authorizedBy: 'ciso@wedos' },
      ],
      envAllowlist: ['bank.cz'],
    });
    renderWithRouter(<ZonesPage />);
    await screen.findByText('bank.cz');
    // Only the onboarded row remains; the env duplicate is filtered out.
    expect(screen.getAllByText('bank.cz')).toHaveLength(1);
    expect(screen.queryByText(/env-allowlisted/)).not.toBeInTheDocument();
  });

  it('refreshes the effective allowlist after a CISO authorizes a target', async () => {
    currentApp = makeApp({ role: 'ciso', authRequired: true });
    fakeApi.zones.mockResolvedValue([]);
    fakeApi.targets.mockResolvedValue({
      targets: [
        { id: 't1', host: 'app.customer.eu', authStatus: 'requested', authRequestedBy: 'op@wedos' },
      ],
      envAllowlist: [],
    });
    fakeApi.authorizeTarget.mockResolvedValue({
      id: 't1',
      host: 'app.customer.eu',
      authStatus: 'authorized',
      authorizedBy: 'ciso@wedos',
    });
    renderWithRouter(<ZonesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(fakeApi.authorizeTarget).toHaveBeenCalledWith('t1'));
    // The allowlist changed → the shared /health posture is refreshed.
    await waitFor(() => expect(currentApp.refreshHealth).toHaveBeenCalled());
  });
});
