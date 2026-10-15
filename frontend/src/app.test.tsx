import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fakeApi = {
  clientWorkspaces: vi.fn().mockResolvedValue({
    targetLevel: 5,
    pilot: { sites: 2, independentProbe: 1, capacityQualified: false },
    clients: [],
  }),
  health: vi.fn(),
  agents: vi.fn().mockResolvedValue({ default: 'builtin', agents: [] }),
  listCampaigns: vi.fn().mockResolvedValue([]),
  wrsHistory: vi.fn().mockResolvedValue([]),
  audit: vi.fn().mockResolvedValue([]),
  alerts: vi.fn().mockResolvedValue([]),
  impact: vi.fn().mockResolvedValue({ impact: [] }),
  observabilitySummary: vi.fn().mockResolvedValue([]),
  me: vi.fn().mockResolvedValue({ email: null, role: null }),
  listUsers: vi.fn().mockResolvedValue([]),
  playbooks: vi.fn().mockResolvedValue([]),
  suites: vi.fn().mockResolvedValue([]),
  assistantStatus: vi
    .fn()
    .mockResolvedValue({ configured: false, model: 'qwen', podManaged: false }),
  assistantPod: vi.fn().mockResolvedValue({ configured: false, state: 'UNKNOWN' }),
  assistantPodStart: vi.fn().mockResolvedValue({ state: 'STARTING' }),
  assistantPodStop: vi.fn().mockResolvedValue({ state: 'STOPPED' }),
};

vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return {
    ...actual,
    api: fakeApi,
    setToken: vi.fn(),
    getToken: vi.fn(() => localStorage.getItem('token')),
  };
});

const { App } = await import('./App.js');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fakeApi.health.mockResolvedValue({
    allowedTargets: ['h'],
    authRequired: false,
  });
  fakeApi.agents.mockResolvedValue({ default: 'builtin', agents: [] });
  fakeApi.listCampaigns.mockResolvedValue([]);
  fakeApi.wrsHistory.mockResolvedValue([]);
});

describe('App gate', () => {
  it('shows the loading state until auth is checked', () => {
    fakeApi.health.mockReturnValue(new Promise(() => {})); // never resolves
    render(<App />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('renders the routed app when auth is not required', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument(),
    );
    // The build version tag is shown at the bottom of every page (sidebar foot).
    expect(screen.getByText(/^v\d+\.\d+\.\d+\+\d+ · \S+$/)).toBeInTheDocument();
  });

  it('shows the sign-in screen when auth is required and no one is signed in', async () => {
    fakeApi.health.mockResolvedValue({
      allowedTargets: [],
      authRequired: true,
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(),
    );
    // The version tag also appears on the sign-in gate.
    expect(screen.getByText(/^v\d+\.\d+\.\d+\+\d+ · \S+$/)).toBeInTheDocument();
  });

  it('forces a password change when the signed-in account has a temp password', async () => {
    fakeApi.health.mockResolvedValue({
      allowedTargets: [],
      authRequired: true,
    });
    localStorage.setItem('token', 'temp-session');
    fakeApi.me.mockResolvedValue({
      email: 'temp@wedos',
      role: 'engineer',
      mustChangePassword: true,
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument(),
    );
    // The routed app is NOT reachable until the password is changed.
    expect(screen.queryByRole('heading', { name: 'Command Center' })).not.toBeInTheDocument();
  });
});

it('uses the client-first navigation for DRS planning and keeps technical tools secondary', async () => {
  fakeApi.health.mockResolvedValue({
    allowedTargets: ['127.0.0.1'],
    authRequired: false,
    drsWorkflow: true,
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'DRS workspace' });
  expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients');
  expect(screen.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute(
    'href',
    '/infrastructure',
  );
  expect(screen.getByRole('link', { name: 'Evidence archive' })).toHaveAttribute(
    'href',
    '/reports',
  );
  expect(screen.getByText('Technical tools')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open the assistant' })).not.toBeInTheDocument();
});
