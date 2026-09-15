import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { CampaignRun, Campaign } from './api.js';

// CampaignCard now uses useNavigate ("Watch live →"), so every render needs a
// Router in context.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

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
  protection: { source: 'mock', detectionTimeSec: 12, mitigationTimeSec: 30 },
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
    // Measured protection surfaces TTD/TTM.
    expect(screen.getByText('Time to detect (TTD)')).toBeInTheDocument();
    expect(screen.getByText('12s')).toBeInTheDocument();
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

  it('leads with the faithful verdict (same as the report) incl. caveats', () => {
    const withAssessment: CampaignRun = {
      ...run,
      assessment: {
        verdict: 'inconclusive',
        mechanism: 'served',
        observation: 'Delivered only 18% of the DRS 5 target rate — INCONCLUSIVE at full rate.',
        caveats: ['Delivered only 18% of the configured rate (141/800 req/s).'],
        underDelivered: true,
        confident: false,
        deliveryRatio: 0.18,
        achievedRps: 141,
        configuredRps: 800,
      },
    };
    render(<RunDetails run={withAssessment} />);
    expect(screen.getByText('inconclusive')).toBeInTheDocument();
    expect(screen.getByText(/mechanism:/)).toBeInTheDocument();
    expect(screen.getByText(/INCONCLUSIVE at full rate/)).toBeInTheDocument();
    expect(screen.getByText(/141\/800 req\/s/)).toBeInTheDocument();
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

function appWith(
  role: 'engineer' | 'ciso' | 'viewer' | 'ciso',
  extra: Record<string, unknown> = {},
) {
  return {
    busy: {},
    killing: {},
    role,
    authRequired: true,
    requireCisoApproval: false,
    setApproveFor: vi.fn(),
    setConfirmExec: vi.fn(),
    kill: vi.fn(),
    cancel: vi.fn(),
    cisoApprove: vi.fn(),
    openDetail: vi.fn(),
    ...extra,
  };
}

describe('CampaignCard RBAC gating', () => {
  it('shows Approve/Reject to an officer on a pending campaign', () => {
    fakeApp = appWith('ciso');
    render(<CampaignCard c={baseCampaign} />);
    expect(screen.getByRole('button', { name: /Approve \/ Reject/ })).toBeInTheDocument();
  });

  it('hides Approve/Reject from an engineer', () => {
    fakeApp = appWith('engineer');
    render(<CampaignCard c={baseCampaign} />);
    expect(screen.queryByRole('button', { name: /Approve \/ Reject/ })).toBeNull();
  });

  it('explains an auto-kill instead of showing a bare status', () => {
    fakeApp = appWith('ciso');
    const detail =
      'Auto-killed: the legitimate probe found the target unavailable for ≥30 s (availability 12% over 8 checks).';
    render(<CampaignCard c={{ ...baseCampaign, status: 'KILLED_AUTO', statusDetail: detail }} />);
    expect(screen.getByText('Auto-killed')).toBeInTheDocument(); // the badge
    expect(screen.getByText(new RegExp('target unavailable'))).toBeInTheDocument(); // the cause
  });

  it('does not render a kill note for a clean completion', () => {
    fakeApp = appWith('ciso');
    render(<CampaignCard c={{ ...baseCampaign, status: 'COMPLETED' }} />);
    expect(screen.queryByText(/Auto-killed:/)).toBeNull();
  });

  it('offers Cancel to an officer on an unrun campaign and calls app.cancel', () => {
    fakeApp = appWith('ciso');
    render(<CampaignCard c={{ ...baseCampaign, status: 'APPROVED' }} />);
    const btn = screen.getByRole('button', { name: /^Cancel$/ });
    fireEvent.click(btn);
    expect(fakeApp.cancel as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('does not offer Cancel once the campaign is terminal', () => {
    fakeApp = appWith('ciso');
    render(<CampaignCard c={{ ...baseCampaign, status: 'CANCELLED', statusDetail: 'done' }} />);
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull();
    expect(screen.getByText('Cancelled')).toBeInTheDocument(); // the badge
  });
});

describe('CampaignCard — dual control (CISO gate)', () => {
  const approved = { ...baseCampaign, status: 'APPROVED' as const, approvedBy: 'off@wedos' };

  it('offers the CISO sign-off to a CISO on an unsigned approved campaign', () => {
    fakeApp = appWith('ciso', { requireCisoApproval: true, identity: { email: 'ciso@wedos' } });
    render(<CampaignCard c={approved} />);
    const btn = screen.getByRole('button', { name: /CISO sign-off/ });
    fireEvent.click(btn);
    expect(fakeApp.cisoApprove as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/CISO pending/)).toBeInTheDocument();
  });

  it('gates Run for the engineer until the CISO has signed off', () => {
    fakeApp = appWith('engineer', { requireCisoApproval: true, identity: { email: 'eng@wedos' } });
    render(<CampaignCard c={approved} />);
    expect(screen.queryByRole('button', { name: /^Run$/ })).toBeNull();
  });

  it('shows CISO ✓ and allows Run once signed off', () => {
    fakeApp = appWith('engineer', { requireCisoApproval: true, identity: { email: 'eng@wedos' } });
    render(<CampaignCard c={{ ...approved, cisoApprovedBy: 'ciso@wedos' }} />);
    expect(screen.getByText(/CISO ✓/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeInTheDocument();
  });
});
