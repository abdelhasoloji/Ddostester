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

const { ReportsPage, AuditLog, SettingsPage, AccountPage, GuidePage, CampaignLaunch } =
  await import('./pages.js');
const { CampaignsWorkspace } = await import('./campaigns-workspace.js');

const stressPreset = {
  id: 'stress',
  name: 'Stress test',
  icon: '🔥',
  category: 'Stress' as const,
  summary: '',
  when: '',
  maxRps: 800,
  concurrency: 150,
  maxDurationSec: 300,
  profile: 'ramp' as const,
  recommendedAgent: 'builtin',
};

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
    role: 'ciso',
    authRequired: true,
    identity: { email: 'off@wedos', role: 'ciso' },
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

  it('AuditLog (now hosted in Settings) shows an entry', () => {
    renderWithRouter(<AuditLog />);
    expect(screen.getByText('campaign.create')).toBeInTheDocument();
  });

  it('SettingsPage (admin) shows engine/security + user management', () => {
    currentApp = makeApp({
      role: 'admin',
      authRequired: true,
      identity: { email: 'admin@wedos', role: 'admin' },
    });
    renderWithRouter(<SettingsPage />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/Users & access/)).toBeInTheDocument();
    expect(fakeApi.listUsers).toHaveBeenCalled();
    // The personal sections moved to My account — Settings is admin-only now.
    expect(screen.queryByRole('heading', { name: 'Security' })).not.toBeInTheDocument();
  });

  it('AccountPage shows profile, role, security and appearance', () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'admin',
      identity: { email: 'adm@wedos', role: 'admin' },
    });
    renderWithRouter(<AccountPage />);
    expect(screen.getByRole('heading', { name: 'My account' })).toBeInTheDocument();
    expect(screen.getByText('adm@wedos')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument(); // role chip
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument(); // change-password
    expect(screen.getByText('Preferences')).toBeInTheDocument();
  });

  it('AccountPage in dev mode shows the operator identity field', () => {
    currentApp = makeApp({ authRequired: false, identity: null });
    renderWithRouter(<AccountPage />);
    expect(screen.getByLabelText('Operator (dev mode)')).toBeInTheDocument();
  });

  it('SettingsPage shows the operational-limits editor only for the admin role', () => {
    // A CISO (default here) does not see the operational-limits editor — limits
    // are administered by the admin.
    renderWithRouter(<SettingsPage />);
    expect(screen.queryByRole('heading', { name: /Operational limits/ })).not.toBeInTheDocument();
  });

  it('SettingsPage (admin) shows the operational-limits editor within the ceiling', () => {
    currentApp = makeApp({
      role: 'admin',
      authRequired: true,
      identity: { email: 'admin@wedos', role: 'admin' },
      hardCaps: { maxRps: 100, maxConcurrency: 50, maxDurationSec: 120 },
      hardCapsCeiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    });
    renderWithRouter(<SettingsPage />);
    expect(screen.getByRole('heading', { name: /Operational limits/ })).toBeInTheDocument();
    // The RPS input is capped at the ceiling and pre-filled with the effective value.
    const rps = screen.getByDisplayValue('100') as HTMLInputElement;
    expect(rps.max).toBe('2000');
    // The admin administers the platform: the user-management card is present too.
    expect(screen.getByText(/Users & access/)).toBeInTheDocument();
  });

  it('GuidePage', () => {
    renderWithRouter(<GuidePage />);
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
  });
});

describe('CampaignLaunch — queued-seed hand-off', () => {
  it('a preset queued from the Guide opens a persistent seeded form (not the recon picker)', () => {
    // Regression: the preset used to be consumed by an in-form effect that
    // self-cleared draftPreset, unmounting the just-seeded form on the same tick
    // and dropping the operator onto the recon target-picker. It now seeds the
    // form through `initial`, cleared only by closeForm.
    currentApp = makeApp({ role: 'engineer', draftPreset: stressPreset });
    renderWithRouter(<CampaignLaunch />);
    // The seeded form is shown, with the preset's name and load shape pre-filled.
    expect(screen.getByRole('heading', { name: 'New campaign' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Stress test')).toBeInTheDocument();
    expect(screen.getByDisplayValue('800')).toBeInTheDocument();
    // The form persists: draftPreset is NOT cleared during render (only on close).
    expect(currentApp.clearDraftPreset).not.toHaveBeenCalled();
  });

  it('read-only roles get the browse-only notice instead of a create surface', () => {
    currentApp = makeApp({ role: 'viewer', authRequired: true, draftPreset: stressPreset });
    renderWithRouter(<CampaignLaunch />);
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New campaign' })).toBeNull();
  });
});
