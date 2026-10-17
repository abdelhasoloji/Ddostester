import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { ZoneSummary, ProtectedTarget, Campaign } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));
const { ZonesPage, protectedHost } = await import('./zones-page.js');
const zone = (host: string): ZoneSummary => ({
  host,
  campaigns: 3,
  suites: 1,
  running: false,
  regression: false,
  lastWrs: 99,
  lastLevel: 'A+',
  maxDrs: 5,
  lastAbsorbedPct: 99,
});
const target = (over: Partial<ProtectedTarget> = {}): ProtectedTarget => ({
  id: 't1',
  host: 'bank.cz',
  authStatus: 'authorized',
  displayName: 'Bank',
  owner: 'SOC',
  createdBy: 'admin',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});
beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({});
  fakeApi.targets.mockResolvedValue({ targets: [], envAllowlist: [] });
  fakeApi.zones.mockResolvedValue([]);
});

describe('Protected zones workspace', () => {
  it('uses current authorization, never historic scores, as its default estate', async () => {
    fakeApi.targets.mockResolvedValue({ targets: [target()], envAllowlist: ['46.28.109.92'] });
    fakeApi.zones.mockResolvedValue([zone('retired.example')]);
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByText('bank.cz')).toBeInTheDocument();
    expect(screen.getByText('46.28.109.92')).toBeInTheDocument();
    expect(fakeApi.zones).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Authorization filter')).toHaveValue('authorized');
    expect(screen.queryByText('retired.example')).not.toBeInTheDocument();
    expect(screen.queryByText(/resilient|DRS reached|Edge absorbed|A\+/)).not.toBeInTheDocument();
    expect(screen.getByText('Service health: not monitored here')).toBeInTheDocument();
  });
  it('separates historical-only hosts and keeps archived evidence reachable', async () => {
    fakeApi.zones.mockResolvedValue([zone('retired.example')]);
    renderWithRouter(<ZonesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Historical activity' }));
    expect(await screen.findByText('retired.example')).toBeInTheDocument();
    expect(screen.getByText('Outside authorized scope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View campaigns' }));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/campaigns?tab=history&host=retired.example&archived=1',
    );
    expect(screen.queryByText('DRS 5')).not.toBeInTheDocument();
  });
  it('deduplicates configured and registered hosts and explains independent configured access', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'revoked' })],
      envAllowlist: ['BANK.CZ.', 'bank.cz'],
    });
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByText('bank.cz')).toBeInTheDocument();
    expect(screen.getAllByText('bank.cz')).toHaveLength(1);
    expect(screen.getByText('Configured access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure campaign' })).toBeEnabled();
  });
  it('filters by host/name and effective authorization without treating revocation as health', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [
        target(),
        target({ id: 't2', host: 'other.example', authStatus: 'revoked', displayName: 'Other' }),
      ],
      envAllowlist: [],
    });
    renderWithRouter(<ZonesPage />);
    await screen.findByText('bank.cz');
    fireEvent.change(screen.getByLabelText('Search zones'), { target: { value: 'Bank' } });
    expect(screen.queryByText('other.example')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search zones'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Authorization filter'), {
      target: { value: 'pending' },
    });
    expect(screen.queryByText('bank.cz')).not.toBeInTheDocument();
    expect(screen.getByText('other.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure campaign' })).toBeDisabled();
  });
  it('routes configuration through templates and live activity to the correct campaign', async () => {
    currentApp = makeApp({
      campaigns: [
        {
          id: 'live',
          target: 'http://46.28.109.92:8080/path',
          status: 'RUNNING',
          createdAt: '2026-10-17T00:00:00Z',
        } as Campaign,
      ],
    });
    fakeApi.targets.mockResolvedValue({ targets: [], envAllowlist: ['46.28.109.92'] });
    renderWithRouter(<ZonesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure campaign' }));
    expect(mockNavigate).toHaveBeenCalledWith(
      '/campaigns?tab=templates&target=http%3A%2F%2F46.28.109.92%3A8080%2F',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Watch live' }));
    expect(mockNavigate).toHaveBeenCalledWith('/theater?run=live');
    expect(fakeApi.execute).not.toHaveBeenCalled();
  });
  it('fails closed on registry errors, retries, and does not advertise stale configured access', async () => {
    fakeApi.targets.mockRejectedValueOnce(new Error('offline'));
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load targets");
    fakeApi.targets.mockResolvedValue({ targets: [target()], envAllowlist: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('bank.cz');
    fakeApi.targets.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText('bank.cz')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Configure campaign' })).not.toBeInTheDocument();
  });
  it('keeps history failures independent from current scope and supports history pagination/search', async () => {
    fakeApi.targets.mockResolvedValue({ targets: [target()], envAllowlist: [] });
    fakeApi.zones.mockRejectedValueOnce(new Error('offline'));
    renderWithRouter(<ZonesPage />);
    await screen.findByText('bank.cz');
    fireEvent.click(screen.getByRole('button', { name: 'Historical activity' }));
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('historical activity');
    expect(screen.getByText('bank.cz')).toBeInTheDocument();
    fakeApi.zones.mockResolvedValue(Array.from({ length: 11 }, (_, i) => zone(`old-${i}.example`)));
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    await screen.findByText('old-0.example');
    expect(screen.queryByText('old-10.example')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('old-10.example')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search history'), { target: { value: 'old-0.' } });
    expect(screen.getByText('old-0.example')).toBeInTheDocument();
  });
  it('preserves read-only capability restrictions', async () => {
    currentApp = makeApp({ role: 'viewer', authRequired: true });
    fakeApi.targets.mockResolvedValue({ targets: [target()], envAllowlist: [] });
    renderWithRouter(<ZonesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure campaign' })).not.toBeInTheDocument();
  });
});

it('canonicalizes ports, URL paths, case and trailing dots consistently with host authorization', () => {
  expect(protectedHost('https://BANK.cz.:8443/path')).toBe('bank.cz');
  expect(protectedHost('bank.cz:8080')).toBe('bank.cz');
  expect(protectedHost('bad host')).toBe('');
});

it('does not label historical access as revoked or absent when the registry is unavailable', async () => {
  fakeApi.targets.mockRejectedValueOnce(new Error('offline'));
  fakeApi.zones.mockResolvedValue([zone('bank.cz')]);
  renderWithRouter(<ZonesPage />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Historical activity' }));
  expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Outside authorized scope')).not.toBeInTheDocument();
});
