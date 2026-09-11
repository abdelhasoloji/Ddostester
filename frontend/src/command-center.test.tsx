import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

// --- fixtures (defined before fakeApi so the mock factory can close over it) ---
const wrs = {
  wrs: 62,
  level: 'D' as const,
  detection: 0.5,
  mitigation: 0.5,
  availability: 0.8,
  collateral: 0.9,
};

const runFixture = {
  runId: 'run1',
  campaignId: 'c1',
  status: 'COMPLETED' as const,
  generator: {
    totalRequests: 1000,
    successful: 600,
    failed: 400,
    actualRps: 80,
    latencyMs: { min: 1, max: 90, mean: 20, p50: 18, p95: 40, p99: 80 },
    statusCounts: { '2xx': 600, '429': 400 },
    errors: {},
    hardStopped: false,
  },
  probe: {
    samples: 10,
    available: 10,
    errorRate5xx: 0,
    latencyMs: { p50: 10, p95: 20, p99: 30 },
    successful: 10,
  },
  wrs,
  absorption: {
    configuredRps: 100,
    achievedRps: 80,
    originRps: 6,
    absorbedRatio: 0.4,
    absorbedPct: 40,
    totalRequests: 1000,
  },
  confidence: { degraded: true, reasons: ['generator event-loop lag peaked at 180ms'] },
};

const scoredCampaign = {
  id: 'c1',
  name: 'burst-resilience',
  target: 'https://bank.cz',
  status: 'COMPLETED' as const,
  maxRps: 100,
  runId: 'run1',
  wrs,
};

const alerts = [
  {
    severity: 'warning' as const,
    key: 'run1:low-wrs',
    kind: 'low-wrs' as const,
    title: 'Low WRS 62 (D) — burst-resilience',
    detail: 'WRS below 70',
    runId: 'run1',
    target: 'bank.cz',
  },
  {
    severity: 'info' as const,
    key: 'run1:degraded',
    kind: 'degraded' as const,
    title: 'Measurement degraded — burst-resilience',
    detail: 'generator saturated',
    runId: 'run1',
    target: 'bank.cz',
  },
];

const wrsSeries = [
  {
    target: 'bank.cz',
    points: [
      { at: '2026-09-10T09:00:00Z', wrs: 90, level: 'A', runId: 'run0' },
      { at: '2026-09-10T10:00:00Z', wrs: 62, level: 'D', runId: 'run1' },
    ],
    regression: true,
    drop: 28,
  },
];

let currentApp: ReturnType<typeof makeApp>;
const getRun = vi.fn().mockResolvedValue(runFixture);
const fakeApi = makeApi({ getRun });

vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});

const { CommandCenterPage, RunTheaterPage, ReportsPage } = await import('./pages.js');

// --- EventSource mock so Run Theater can subscribe in jsdom ---
const esInstances: MockES[] = [];
class MockES {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  close() {}
}

beforeEach(() => {
  getRun.mockResolvedValue(runFixture);
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockES;
  esInstances.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('Command Center', () => {
  it('shows fleet resilience, alerts and the most-recent last result', async () => {
    currentApp = makeApp({ role: 'engineer', campaigns: [scoredCampaign], alerts, wrsSeries });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument();
    expect(screen.getByText(/Active alerts · from recent runs/)).toBeInTheDocument();
    expect(screen.getByText(/Low WRS 62/)).toBeInTheDocument();
    await waitFor(() => expect(getRun).toHaveBeenCalledWith('run1'));
    await waitFor(() => expect(screen.getByText(/Protection absorption/)).toBeInTheDocument());
  });

  it('routes the Security Officer to pending approvals', () => {
    currentApp = makeApp({
      role: 'officer',
      identity: { email: 'off@wedos', role: 'officer' },
      campaigns: [{ ...scoredCampaign, id: 'p1', status: 'PENDING_APPROVAL', wrs: undefined }],
    });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByText('For the Security Officer')).toBeInTheDocument();
    expect(screen.getByText(/awaiting your approval/)).toBeInTheDocument();
  });

  it('shows a read-only focus for viewers', () => {
    currentApp = makeApp({ role: 'viewer', campaigns: [] });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByText('For you')).toBeInTheDocument();
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });
});

describe('Run Theater', () => {
  it('points to Campaigns when nothing is in flight', () => {
    currentApp = makeApp({ role: 'engineer', campaigns: [scoredCampaign] });
    renderWithRouter(<RunTheaterPage />);
    expect(screen.getByRole('heading', { name: 'Run Theater' })).toBeInTheDocument();
    expect(screen.getByText(/No run in flight/)).toBeInTheDocument();
  });

  it('renders live offered/origin/absorbed from the stream for a running campaign', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    renderWithRouter(<RunTheaterPage />);
    expect(esInstances.length).toBeGreaterThan(0);
    act(() => {
      esInstances[0].onmessage?.({
        data: JSON.stringify({
          status: 'RUNNING',
          sent: 1000,
          successful: 200,
          failed: 800,
          elapsedSec: 10,
          actualRps: 100,
          maxDurationSec: 60,
          engine: 'k6',
          statusCounts: { '2xx': 200, '429': 800 },
          probe: { samples: 5, available: 5, errorRate5xx: 0 },
          timeline: [
            { t: 1, rps: 90, sent: 90, failed: 60, probe5xx: 0, availPct: 100 },
            { t: 2, rps: 100, sent: 190, failed: 150, probe5xx: 0, availPct: 100 },
          ],
        }),
      });
    });
    expect(screen.getByText('Absorbed by edge')).toBeInTheDocument();
    expect(screen.getByText('Reached origin')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument(); // 800/1000 offered → 80% absorbed
  });

  it('surfaces a dropped stream instead of spinning forever', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    renderWithRouter(<RunTheaterPage />);
    expect(esInstances.length).toBeGreaterThan(0);
    // No data ever arrived, then the connection drops.
    act(() => esInstances[0].onerror?.());
    expect(screen.getByText(/Live updates interrupted/)).toBeInTheDocument();
    expect(screen.queryByText(/Starting run…/)).not.toBeInTheDocument();
  });
});

describe('Results page', () => {
  it('expands a run inline with its full detail', async () => {
    currentApp = makeApp({ role: 'engineer', campaigns: [scoredCampaign] });
    renderWithRouter(<ReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await waitFor(() => expect(getRun).toHaveBeenCalledWith('run1'));
    await waitFor(() => expect(screen.getByText(/Protection absorption/)).toBeInTheDocument());
  });
});
