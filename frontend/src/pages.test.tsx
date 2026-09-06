import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
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

const { OverviewPage, CampaignsPage, ReportsPage, AuditPage, SettingsPage, GuidePage } =
  await import('./pages.js');

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
  it('OverviewPage', () => {
    renderWithRouter(<OverviewPage />);
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('CampaignsPage lists campaigns', () => {
    renderWithRouter(<CampaignsPage />);
    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByText('Baseline')).toBeInTheDocument();
  });

  it('ReportsPage', () => {
    renderWithRouter(<ReportsPage />);
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
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

  it('GuidePage', () => {
    renderWithRouter(<GuidePage />);
    expect(screen.getByRole('heading', { name: 'Guide' })).toBeInTheDocument();
  });
});
