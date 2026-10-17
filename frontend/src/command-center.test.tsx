import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

const { CommandCenterPage } = await import('./pages.js');
const { RunTheaterPage } = await import('./run-theater.js');

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
    // Each alert carries a colored severity pill for at-a-glance triage.
    expect(document.querySelector('.alert-sev-warning')?.textContent?.trim()).toBe('warning');
    expect(document.querySelector('.alert-sev-info')?.textContent?.trim()).toBe('info');
    await waitFor(() => expect(getRun).toHaveBeenCalledWith('run1'));
    await waitFor(() => expect(screen.getByText(/Generator outcomes/)).toBeInTheDocument());
  });

  it('routes the CISO to pending approvals', () => {
    currentApp = makeApp({
      role: 'ciso',
      identity: { email: 'ciso@wedos', role: 'ciso' },
      campaigns: [{ ...scoredCampaign, id: 'p1', status: 'PENDING_APPROVAL', wrs: undefined }],
    });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByText('For the CISO')).toBeInTheDocument();
    expect(screen.getByText(/awaiting your approval/)).toBeInTheDocument();
  });

  it('shows a read-only focus for viewers', () => {
    currentApp = makeApp({ role: 'viewer', campaigns: [] });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByText('For you')).toBeInTheDocument();
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });

  it('does not count suite steps of an active sequence as awaiting approval', async () => {
    // The sequencer auto-approves each step just-in-time, so a PENDING step of a
    // live suite is NOT an officer action item.
    fakeApi.suiteSequences.mockResolvedValue({
      sequences: { S1: { paused: false, started: 1, total: 3 } },
    });
    currentApp = makeApp({
      role: 'ciso',
      identity: { email: 'off@wedos', role: 'ciso' },
      campaigns: [
        { ...scoredCampaign, id: 's-a', status: 'PENDING_APPROVAL', suiteId: 'S1', wrs: undefined },
        { ...scoredCampaign, id: 's-b', status: 'PENDING_APPROVAL', suiteId: 'S1', wrs: undefined },
      ],
    });
    renderWithRouter(<CommandCenterPage />);
    // Once the sequence poll resolves, the false "awaiting approval" queue clears.
    await waitFor(() =>
      expect(screen.queryByText(/awaiting your approval/)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/No approvals waiting/)).toBeInTheDocument();
  });

  it('still counts a genuinely-pending non-suite campaign', async () => {
    fakeApi.suiteSequences.mockResolvedValue({ sequences: {} });
    currentApp = makeApp({
      role: 'ciso',
      identity: { email: 'off@wedos', role: 'ciso' },
      campaigns: [{ ...scoredCampaign, id: 'p1', status: 'PENDING_APPROVAL', wrs: undefined }],
    });
    renderWithRouter(<CommandCenterPage />);
    expect(screen.getByText(/awaiting your approval/)).toBeInTheDocument();
  });
});

describe('Run Theater', () => {
  it('keeps successful and offered rates aligned when the UI clock advances before generator counters', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    renderWithRouter(<RunTheaterPage />);
    act(() => {
      esInstances[0].onmessage?.({
        data: JSON.stringify({
          status: 'RUNNING',
          sent: 6400,
          successful: 6400,
          failed: 0,
          elapsedSec: 9,
          actualRps: 800,
          maxDurationSec: 20,
          engine: 'vegeta',
          probe: { samples: 5, available: 5, errorRate5xx: 0 },
        }),
      });
    });
    expect(screen.getByText('Successful responses').parentElement).toHaveTextContent('800');
  });
  it('points to Campaigns when nothing is in flight', () => {
    currentApp = makeApp({ role: 'engineer', campaigns: [scoredCampaign] });
    renderWithRouter(<RunTheaterPage />);
    expect(screen.getByRole('heading', { name: 'Run Theater' })).toBeInTheDocument();
    expect(screen.getByText(/No run in flight/)).toBeInTheDocument();
  });

  it('shows a completion card with the replay follow-up when the focused run has finished', () => {
    const finished = { ...scoredCampaign, id: 'm0', name: 'Capacity ceiling', runId: 'r0' };
    const finishedRun = {
      ...runFixture,
      runId: 'r0',
      assessment: {
        verdict: 'breached',
        mechanism: 'tarpitted',
        observation: 'origin buckled',
        caveats: [],
        underDelivered: false,
        confident: true,
        deliveryRatio: 1,
        achievedRps: 80,
        configuredRps: 100,
      },
    };
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [finished],
      runs: { m0: finishedRun },
    });
    render(
      <MemoryRouter initialEntries={['/theater?run=m0']}>
        <RunTheaterPage />
      </MemoryRouter>,
    );
    // Instead of "no run in flight", the finished run stays on stage with a
    // follow-up prompt built from its conclusions.
    expect(screen.getByText(/Run complete — Capacity ceiling/)).toBeInTheDocument();
    expect(screen.queryByText(/No run in flight/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Replay accounting for countermeasures/i }),
    ).toBeInTheDocument();
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
    expect(screen.getByText('Generator failures')).toBeInTheDocument();
    expect(screen.getByText('Successful responses')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument(); // 800/1000 offered → 80% absorbed
  });

  it('does not claim a service outage from generator failures when the probe is healthy', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    renderWithRouter(<RunTheaterPage />);
    act(() =>
      esInstances[0].onmessage?.({
        data: JSON.stringify({
          status: 'RUNNING',
          sent: 100,
          successful: 0,
          failed: 100,
          generatorObserved: true,
          elapsedSec: 10,
          actualRps: 10,
          maxDurationSec: 20,
          statusCounts: { '5xx': 100 },
          probe: { samples: 4, available: 4, health: 'ok' },
        }),
      }),
    );
    expect(screen.queryByText(/TARGET DOWN/)).toBeNull();
    expect(screen.queryByText(/legitimate users can.t get through/)).toBeNull();
    expect(screen.getByText(/a service outage is not established/)).toBeInTheDocument();
  });
  it('shows unknown generator counters from the first tick, including the warning banner', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    const { container } = renderWithRouter(<RunTheaterPage />);
    act(() =>
      esInstances[0].onmessage?.({
        data: JSON.stringify({
          status: 'RUNNING',
          sent: 0,
          successful: 0,
          failed: 0,
          generatorObserved: false,
          elapsedSec: 1,
          actualRps: 0,
          maxDurationSec: 20,
          probe: { samples: 1, available: 0, health: 'critical' },
        }),
      }),
    );
    expect(container.querySelectorAll('.tm-na').length).toBe(3);
    expect(container.querySelector('.td-stats')?.textContent).toContain('— generator failures');
  });
  it('shows connection-hold cards (not request cards) for a slowloris run', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING', vector: 'http-slowloris' }],
    });
    renderWithRouter(<RunTheaterPage />);
    expect(esInstances.length).toBeGreaterThan(0);
    act(() => {
      esInstances[0].onmessage?.({
        data: JSON.stringify({
          status: 'RUNNING',
          sent: 300, // connections opened
          successful: 5, // currently held
          failed: 295, // shed by target
          elapsedSec: 20,
          actualRps: 0,
          maxDurationSec: 300,
          engine: 'builtin-http',
          probe: { samples: 5, available: 5, errorRate5xx: 0 },
        }),
      });
    });
    // Slowloris story, not the request-rate cards.
    expect(screen.getByText('Connections opened')).toBeInTheDocument();
    expect(screen.getByText('Currently held')).toBeInTheDocument();
    expect(screen.getByText('Connections closed')).toBeInTheDocument();
    expect(screen.queryByText('Offered')).not.toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument(); // opened
    expect(screen.getByText(/98%/)).toBeInTheDocument(); // 295/300 shed
  });

  it('surfaces a dropped stream instead of spinning forever', () => {
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [{ ...scoredCampaign, status: 'RUNNING' }],
    });
    renderWithRouter(<RunTheaterPage />);
    expect(esInstances.length).toBeGreaterThan(0);
    const close = vi.spyOn(esInstances[0], 'close');
    // No data ever arrived, then the connection drops.
    act(() => esInstances[0].onerror?.());
    expect(screen.getByText(/Live updates interrupted/)).toBeInTheDocument();
    expect(screen.queryByText(/Starting run…/)).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });

  it('shows failed execution as attempted with a report instead of queued', async () => {
    fakeApi.suiteSequences.mockResolvedValue({
      sequences: { S1: { paused: false, started: 1, total: 1 } },
    });
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [
        {
          ...scoredCampaign,
          id: 'failed',
          suiteId: 'S1',
          suiteOrder: 0,
          status: 'APPROVED',
          wrs: undefined,
          statusDetail: 'Last run failed (reference diag-123); review before retrying.',
        },
      ],
    });
    renderWithRouter(<RunTheaterPage />);
    await waitFor(() => expect(screen.getByText('Execution failed')).toBeInTheDocument());
    expect(screen.queryByText('queued')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open report' })).toHaveAttribute(
      'href',
      '/api/suites/S1/report',
    );
  });

  it('keeps the suite surface between steps (recovery gate), not "no run"', async () => {
    // A live suite whose current wave has settled (nothing RUNNING) but the
    // sequence is still in flight: the recovery gate is holding for the next
    // step. The theater must show the stepper + gate, never "no run in flight".
    fakeApi.suiteSequences.mockResolvedValue({
      sequences: { S1: { paused: false, started: 1, total: 2 } },
    });
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [
        {
          ...scoredCampaign,
          id: 'm0',
          name: 'x — y — Search flood (A)',
          suiteId: 'S1',
          suiteOrder: 0,
          status: 'COMPLETED',
          wrs,
        },
        {
          ...scoredCampaign,
          id: 'm1',
          name: 'x — y — POST flood (A)',
          suiteId: 'S1',
          suiteOrder: 1,
          status: 'APPROVED',
          wrs: undefined,
        },
      ],
    });
    renderWithRouter(<RunTheaterPage />);
    // The poll resolves the active sequence → suite surface renders.
    await waitFor(() => expect(screen.getByText('Recovery gate')).toBeInTheDocument());
    expect(screen.queryByText(/No run in flight/)).not.toBeInTheDocument();
    // Recon is foregrounded, and the completed step shows its WRS.
    await waitFor(() => expect(screen.getByText('LiteSpeed')).toBeInTheDocument());
    expect(screen.getByText('Search flood (A)')).toBeInTheDocument();
    // The next step appears in the stepper and again in the gate's "Next:" line.
    expect(screen.getAllByText('POST flood (A)').length).toBeGreaterThan(0);
    // While a sequence is in flight, the page refreshes campaigns itself — the
    // context's own poll is off during the gate (nothing RUNNING), so without
    // this the theater would never advance past the gate banner.
    await waitFor(() => expect(currentApp.refresh).toHaveBeenCalled());
  });

  it('shows an "origin appears down" card when the sequence auto-paused', async () => {
    // The sequencer auto-paused because the target stayed unreachable — the gate
    // must surface DOWN (not a plain "recovering"/"paused") so the operator acts.
    fakeApi.suiteSequences.mockResolvedValue({
      sequences: { S1: { paused: true, autoPaused: true, downSkips: 2, started: 1, total: 3 } },
    });
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [
        {
          ...scoredCampaign,
          id: 'm0',
          name: 'x — y — Search flood (A)',
          suiteId: 'S1',
          suiteOrder: 0,
          status: 'COMPLETED',
          wrs,
        },
        {
          ...scoredCampaign,
          id: 'm1',
          name: 'x — y — POST flood (A)',
          suiteId: 'S1',
          suiteOrder: 1,
          status: 'APPROVED',
          wrs: undefined,
        },
      ],
    });
    renderWithRouter(<RunTheaterPage />);
    await waitFor(() => expect(screen.getByText('Origin appears down')).toBeInTheDocument());
    expect(screen.getByText(/auto-paused/)).toBeInTheDocument();
    expect(screen.queryByText('Recovery gate')).not.toBeInTheDocument();
  });

  it('opens the full target-intelligence dossier from the recon strip', async () => {
    fakeApi.suiteSequences.mockResolvedValue({
      sequences: { S1: { paused: false, started: 1, total: 2 } },
    });
    currentApp = makeApp({
      role: 'engineer',
      campaigns: [
        {
          ...scoredCampaign,
          id: 'm0',
          name: 'x — y — Search flood (A)',
          suiteId: 'S1',
          suiteOrder: 0,
          status: 'COMPLETED',
          wrs,
        },
        {
          ...scoredCampaign,
          id: 'm1',
          name: 'x — y — POST flood (A)',
          suiteId: 'S1',
          suiteOrder: 1,
          status: 'APPROVED',
          wrs: undefined,
        },
      ],
    });
    renderWithRouter(<RunTheaterPage />);
    const strip = await screen.findByTitle('Open the full target intelligence');
    fireEvent.click(strip);
    // The dossier renders the full detail: heading, sections, and a seeded path.
    expect(screen.getByRole('dialog', { name: /Target intelligence/ })).toBeInTheDocument();
    expect(screen.getByText('Fingerprint')).toBeInTheDocument();
    expect(screen.getByText('Edge posture')).toBeInTheDocument();
    expect(screen.getByText('/search')).toBeInTheDocument();
  });
});

it('shows a persisted baseline failure after reconnect instead of opening a stale running stream', () => {
  currentApp = makeApp({
    campaigns: [
      {
        ...scoredCampaign,
        status: 'APPROVED',
        statusDetail:
          'Last run failed (reference test); DRS baseline unstable; CV 0.25 / 0.1; no injection',
      },
    ],
  });
  render(
    <MemoryRouter initialEntries={['/theater?run=c1']}>
      <RunTheaterPage />
    </MemoryRouter>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('DRS baseline unstable');
  expect(screen.getByRole('link', { name: 'Review the DRS report' })).toHaveAttribute(
    'href',
    '/campaigns?tab=evidence&campaign=c1',
  );
  expect(esInstances).toHaveLength(0);
});
