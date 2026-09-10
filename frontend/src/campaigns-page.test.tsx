import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign, CampaignStatus } from './api.js';

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

const { CampaignsPage } = await import('./pages.js');

function member(order: number, status: CampaignStatus, extra: Partial<Campaign> = {}): Campaign {
  return {
    id: `c${order}`,
    name: `Suite X — step ${order}`,
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    vector: 'http-get',
    status,
    createdBy: 'eng@wedos',
    maxRps: 100,
    concurrency: 20,
    maxDurationSec: 60,
    suiteId: 'suite-1',
    suiteName: 'Suite X',
    suiteOrder: order,
    ...extra,
  };
}

const wrs = (v: number) =>
  ({ detection: v, mitigation: v, availability: v, collateral: v, wrs: v, level: 'B' }) as never;

describe('CampaignsPage — suite grouping', () => {
  it('renders a suite as one group with progress, aggregate WRS and timing', () => {
    currentApp = makeApp({
      role: 'officer',
      campaigns: [
        member(0, 'COMPLETED', {
          wrs: wrs(90),
          startedAt: '2026-09-09T10:00:00Z',
          finishedAt: '2026-09-09T10:01:00Z',
          durationSec: 60,
        }),
        member(1, 'COMPLETED', {
          wrs: wrs(60),
          startedAt: '2026-09-09T10:02:00Z',
          finishedAt: '2026-09-09T10:05:00Z',
          durationSec: 180,
        }),
      ],
    });
    renderWithRouter(<CampaignsPage />);
    expect(screen.getByText(/Suite X/)).toBeInTheDocument();
    expect(screen.getByText(/2\/2 steps/)).toBeInTheDocument();
    expect(screen.getByText(/avg 75 · worst 60/)).toBeInTheDocument();
    expect(screen.getByText(/on target/)).toBeInTheDocument(); // Σ 4m on target
  });

  it('collapses done suites and expands to show per-step cards on toggle', () => {
    currentApp = makeApp({
      role: 'officer',
      campaigns: [
        member(0, 'COMPLETED', { wrs: wrs(90) }),
        member(1, 'COMPLETED', { wrs: wrs(80) }),
      ],
    });
    renderWithRouter(<CampaignsPage />);
    // Collapsed: no per-step campaign card (.campaign) yet.
    expect(document.querySelector('.suite-group-members')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Suite X/ }));
    expect(document.querySelector('.suite-group-members')).not.toBeNull();
  });

  it('archives a whole suite via app.archiveSuite', async () => {
    currentApp = makeApp({
      role: 'officer',
      campaigns: [
        member(0, 'COMPLETED', { wrs: wrs(90) }),
        member(1, 'COMPLETED', { wrs: wrs(80) }),
      ],
    });
    renderWithRouter(<CampaignsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(currentApp.archiveSuite).toHaveBeenCalledWith('suite-1', 'Suite X', true),
    );
  });

  it('hides archived campaigns until the toggle is enabled', async () => {
    currentApp = makeApp({
      role: 'officer',
      campaigns: [
        { ...member(0, 'COMPLETED'), suiteId: undefined, suiteName: undefined, name: 'Live one' },
        {
          ...member(1, 'COMPLETED'),
          suiteId: undefined,
          suiteName: undefined,
          name: 'Archived one',
          archived: true,
        },
      ],
    });
    renderWithRouter(<CampaignsPage />);
    expect(screen.getByText('Live one')).toBeInTheDocument();
    expect(screen.queryByText('Archived one')).toBeNull();
    // Enable "Archived" toggle → the archived card appears.
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('Archived one')).toBeInTheDocument());
  });
});
