import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

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

const { ReportsPage, AuditPage, SettingsPage, GuidePage } = await import('./pages.js');
const { CampaignsWorkspace } = await import('./campaigns-workspace.js');

const sampleCampaign = {
  id: 'c1',
  name: 'Baseline',
  target: 'https://h.wedos/',
  probeUrl: 'https://h.wedos/',
  vector: 'http-get',
  status: 'COMPLETED' as const,
  createdBy: 'eng@wedos',
  maxRps: 100,
  concurrency: 20,
  maxDurationSec: 120,
  runId: 'run1',
  wrs: {
    wrs: 92,
    level: 'A' as const,
    detection: 1,
    mitigation: 1,
    availability: 1,
    collateral: 1,
  },
};

beforeEach(() => {
  currentApp = makeApp({
    role: 'officer',
    authRequired: true,
    identity: { email: 'off@wedos', role: 'officer' },
    campaigns: [sampleCampaign],
    auditRows: [
      { id: 'a1', at: new Date().toISOString(), actor: 'off@wedos', action: 'campaign.create' },
    ],
    wrsSeries: [
      {
        target: 'h.wedos',
        points: [{ at: new Date().toISOString(), wrs: 92, level: 'A', runId: 'run1' }],
        regression: false,
        drop: 0,
      },
    ],
    notifications: ['slack'],
    protection: true,
  });
});

describe('pages render', () => {
  it('CampaignsWorkspace lists campaigns under the workspace tabs', () => {
    renderWithRouter(<CampaignsWorkspace />);
    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    // The persistent list shows below the tabs regardless of the active tab.
    expect(screen.getByText('Baseline')).toBeInTheDocument();
    // The four workspace tabs are present.
    expect(screen.getByRole('tab', { name: 'Launch' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Templates' })).toBeInTheDocument();
  });

  it('moves between workspace tabs with the arrow keys', () => {
    renderWithRouter(<CampaignsWorkspace />);
    const launch = screen.getByRole('tab', { name: 'Launch' });
    expect(launch).toHaveAttribute('aria-selected', 'true');
    // Roving tabindex: only the active tab is in the tab order.
    expect(launch).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Templates' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(launch, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Templates' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ReportsPage', () => {
    renderWithRouter(<ReportsPage />);
    expect(screen.getByRole('heading', { name: 'Results' })).toBeInTheDocument();
  });

  it('AuditPage shows an entry', () => {
    renderWithRouter(<AuditPage />);
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByText('campaign.create')).toBeInTheDocument();
  });

  it('SettingsPage (officer) shows engine/security + user management', () => {
    renderWithRouter(<SettingsPage />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/Users & access/)).toBeInTheDocument();
    expect(fakeApi.listUsers).toHaveBeenCalled();
  });

  it('SettingsPage shows the CISO limits editor only for the CISO role', () => {
    // Officer (default) does not see the operational-limits editor…
    renderWithRouter(<SettingsPage />);
    expect(screen.queryByRole('heading', { name: /Operational limits/ })).not.toBeInTheDocument();
  });

  it('SettingsPage (CISO) shows the operational-limits editor within the ceiling', () => {
    currentApp = makeApp({
      role: 'ciso',
      authRequired: true,
      identity: { email: 'ciso@wedos', role: 'ciso' },
      hardCaps: { maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 },
      hardCapsCeiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    });
    renderWithRouter(<SettingsPage />);
    expect(screen.getByRole('heading', { name: /Operational limits/ })).toBeInTheDocument();
    // The RPS input is capped at the ceiling and pre-filled with the effective value.
    const rps = screen.getByDisplayValue('100') as HTMLInputElement;
    expect(rps.max).toBe('2000');
    // The CISO is governance-only: no user-management card.
    expect(screen.queryByText(/Users & access/)).not.toBeInTheDocument();
  });

  it('GuidePage', () => {
    renderWithRouter(<GuidePage />);
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeInTheDocument();
  });
});
