import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fakeApi = { runMitigation: vi.fn() };
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});

const { MitigationPanel } = await import('./mitigation-panel.js');

beforeEach(() => vi.clearAllMocks());

describe('MitigationPanel', () => {
  it('renders TTD/TTM, before/after and the verdict for a mitigated run', async () => {
    fakeApi.runMitigation.mockResolvedValue({
      verdict: 'mitigated',
      source: 'wedos-lab-scrubber',
      ttdSec: 3,
      ttmSec: 5,
      before: { fromSec: 0, toSec: 3, samples: 2, absorbedRatio: 0.06, availabilityPct: 85 },
      after: { fromSec: 5, toSec: 9, samples: 4, absorbedRatio: 0.95, availabilityPct: 93.5 },
      absorbedDelta: 0.89,
      availabilityDelta: 8.5,
      wrsBefore: 93.9,
      wrsAfter: 97.4,
      wrsDelta: 3.5,
      note: 'Edge engaged after 5s: absorption 6%→95%.',
    });
    render(<MitigationPanel runId="r1" />);
    expect(await screen.findByText(/✓ mitigated/)).toBeInTheDocument();
    expect(screen.getByText('3s')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('+3.5')).toBeInTheDocument();
    expect(fakeApi.runMitigation).toHaveBeenCalledWith('r1');
  });

  it('flags a not-exercised baseline as theoretical', async () => {
    fakeApi.runMitigation.mockResolvedValue({
      verdict: 'not-exercised',
      source: 'mock',
      ttdSec: 2,
      ttmSec: 4,
      theoretical: true,
      before: { fromSec: 0, toSec: 2, samples: 1, absorbedRatio: 0, availabilityPct: 100 },
      after: { fromSec: 4, toSec: 7, samples: 2, absorbedRatio: 0, availabilityPct: 100 },
      absorbedDelta: 0,
      availabilityDelta: 0,
      wrsBefore: 75.76,
      wrsAfter: 99.4,
      wrsDelta: 23.64,
      note: 'No incident exercised — the WRS delta is theoretical.',
    });
    render(<MitigationPanel runId="rx" />);
    expect(await screen.findByText(/not exercised/)).toBeInTheDocument();
    expect(screen.getByText('theoretical Δ')).toBeInTheDocument();
  });

  it('shows only the note (no table) when there is no measurement', async () => {
    fakeApi.runMitigation.mockResolvedValue({
      verdict: 'no-measurement',
      note: 'No measured protection timing.',
    });
    render(<MitigationPanel runId="r2" />);
    expect(await screen.findByText(/no measurement/)).toBeInTheDocument();
    expect(screen.queryByText('Before')).not.toBeInTheDocument();
  });

  it('renders nothing on a fetch error', async () => {
    fakeApi.runMitigation.mockRejectedValue(new Error('offline'));
    const { container } = render(<MitigationPanel runId="r3" />);
    await waitFor(() => expect(container.querySelector('.mitigation-panel')).toBeNull());
  });
});
