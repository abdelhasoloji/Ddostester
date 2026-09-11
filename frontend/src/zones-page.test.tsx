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
    ]);
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByText(/bank\.cz/)).toBeInTheDocument();
    expect(screen.getByText(/shop\.eu/)).toBeInTheDocument();
    expect(screen.getByText('DRS 5')).toBeInTheDocument();
    expect(screen.getByText('96.4%')).toBeInTheDocument();
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
});
