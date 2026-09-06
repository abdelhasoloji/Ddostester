import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CampaignRun, Campaign } from './api.js';

// CampaignCard reads the app context; keep canDo real, stub useApp per test.
let fakeApp: Record<string, unknown>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => fakeApp };
});

const { StatusBadge, WrsPill, VerdictBadge, RunDetails, CampaignCard } = await import('./ui.js');

describe('badges', () => {
  it('render status, WRS and SLO verdict', () => {
    const { unmount } = render(<StatusBadge status="COMPLETED" />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    unmount();
    render(
      <>
        <WrsPill
          wrs={{ wrs: 92, level: 'A', detection: 1, mitigation: 1, availability: 1, collateral: 1 }}
        />
        <VerdictBadge verdict="FAIL" />
      </>,
    );
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText(/SLO FAIL/)).toBeInTheDocument();
  });
});

const run: CampaignRun = {
  runId: 'r1',
  campaignId: 'c1',
  status: 'COMPLETED',
  generator: {
    totalRequests: 400,
    successful: 398,
    failed: 2,
    actualRps: 50,
    latencyMs: { min: 1, max: 20, mean: 5, p50: 4, p95: 9, p99: 15 },
    statusCounts: { '2xx': 398, '5xx': 2 },
    errors: { TimeoutError: 1 },
    assertionsChecked: 400,
    assertionFailures: 3,
  },
  probe: {
    samples: 8,
    available: 8,
    errorRate5xx: 0,
    latencyMs: { p50: 3, p95: 6, p99: 9 },
    successful: 8,
  },
  wrs: { wrs: 94, level: 'A', detection: 92, mitigation: 85, availability: 100, collateral: 100 },
  acceptance: { verdict: 'FAIL', failures: ['p95 latency 9ms > 5ms'] },
  protectionSource: 'mock',
  timeline: [
    { t: 1, rps: 0, sent: 0, failed: 0, probe5xx: 0, availPct: 100 },
    { t: 2, rps: 50, sent: 50, failed: 0, probe5xx: 0, availPct: 100 },
  ],
};

describe('RunDetails', () => {
  it('renders metrics, status distribution, SLO failure and measured source', () => {
    render(<RunDetails run={run} />);
    expect(screen.getByText('Requests')).toBeInTheDocument();
    expect(screen.getByText('400')).toBeInTheDocument();
    expect(screen.getByText('Assertion failures')).toBeInTheDocument();
    expect(screen.getByText('2xx 398')).toBeInTheDocument();
    expect(screen.getByText('5xx 2')).toBeInTheDocument();
    expect(screen.getByText(/SLO FAIL/)).toBeInTheDocument();
    expect(screen.getByText(/p95 latency/)).toBeInTheDocument();
    expect(screen.getByText(/measured/)).toBeInTheDocument();
  });

  it('renders the baseline and under-load deltas when present', () => {
    const withBaseline: CampaignRun = {
      ...run,
      baseline: { samples: 3, availabilityPct: 100, latencyMs: { p50: 3, p95: 6 } },
      baselineDelta: { latencyP50DeltaMs: 2, latencyP95DeltaMs: 4, availabilityDeltaPct: -5 },
    };
    render(<RunDetails run={withBaseline} />);
    expect(screen.getByText('Baseline availability')).toBeInTheDocument();
    expect(screen.getByText('+4 ms')).toBeInTheDocument();
    expect(screen.getByText('-5 pts')).toBeInTheDocument();
  });
});

const baseCampaign: Campaign = {
  id: 'c1',
  name: 'Test campaign',
  target: 'https://h.wedos/',
  probeUrl: 'https://h.wedos/',
  vector: 'http-get',
  status: 'PENDING_APPROVAL',
  createdBy: 'eng@wedos',
  maxRps: 50,
  concurrency: 10,
  maxDurationSec: 30,
};

function appWith(role: 'engineer' | 'officer' | 'viewer') {
  return {
    busy: {},
    role,
    authRequired: true,
    setApproveFor: vi.fn(),
    setConfirmExec: vi.fn(),
    kill: vi.fn(),
    openDetail: vi.fn(),
  };
}

describe('CampaignCard RBAC gating', () => {
  it('shows Approve/Reject to an officer on a pending campaign', () => {
    fakeApp = appWith('officer');
    render(<CampaignCard c={baseCampaign} />);
    expect(screen.getByRole('button', { name: /Approve \/ Reject/ })).toBeInTheDocument();
  });

  it('hides Approve/Reject from an engineer', () => {
    fakeApp = appWith('engineer');
    render(<CampaignCard c={baseCampaign} />);
    expect(screen.queryByRole('button', { name: /Approve \/ Reject/ })).toBeNull();
  });
});
