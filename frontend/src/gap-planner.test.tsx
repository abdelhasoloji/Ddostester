import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { GapAnalysis } from './api.js';

// GapPlannerSection reads the app context (for app.push) and calls api.gapAnalysis.
let fakeApp: Record<string, unknown>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => fakeApp };
});

const gapAnalysis = vi.fn();
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: { ...actual.api, gapAnalysis } };
});

const { GapPlannerSection } = await import('./pages.js');

const weak = {
  key: 'rateLimiting' as const,
  label: 'Request rate limiting',
  status: 'absent' as const,
};
const ANALYSIS: GapAnalysis = {
  generatedAt: '2026-01-01T00:00:00Z',
  target: 'bank.cz',
  plan: [
    {
      line: 3,
      drs: 3,
      tier: 'DRS 3 — commodity capability',
      name: 'HTTP GET-Flood',
      controls: [weak],
      weakest: weak,
      priority: 'medium',
      score: 6,
      step: 'GET-Flood (DRS3)',
      intensity: { maxRps: 400, concurrency: 80, durationSec: 120, profile: 'constant' },
      combination: false,
      rationale: 'Weakest link: no request rate limiting declared.',
    },
    {
      line: 10,
      drs: 5,
      tier: 'DRS 5 — advanced / nation-state',
      name: 'HTTP MultiVector',
      controls: [weak],
      weakest: weak,
      priority: 'high',
      score: 8,
      step: 'L7 MultiVector (DRS5)',
      intensity: { maxRps: 800, concurrency: 200, durationSec: 180, profile: 'wave' },
      combination: true,
      rationale: 'Weakest link: no request rate limiting declared.',
    },
  ],
  attestationOnly: [
    {
      line: 12,
      drs: 5,
      tier: 'DRS 5 — advanced / nation-state',
      name: 'WAF-Cracker',
      controls: [{ key: 'wafSignatures', label: 'WAF signature ruleset', status: 'unknown' }],
      note: 'weaponized, never emitted',
    },
  ],
  breakPoint: {
    line: 3,
    name: 'HTTP GET-Flood',
    drs: 3,
    weakest: weak,
    note: 'the ladder likely breaks here',
  },
  summary: { high: 1, medium: 1, low: 0, attested: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeApp = { push: vi.fn() };
  gapAnalysis.mockResolvedValue(ANALYSIS);
});

describe('GapPlannerSection', () => {
  it('declares a control and renders the zeroBS ladder + break point on analyze', async () => {
    render(<GapPlannerSection />);
    // Flip one control to 'absent' (exercises the controlled <select> handler).
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'absent' } });

    fireEvent.click(screen.getByRole('button', { name: /Analyze gaps/ }));
    await waitFor(() => expect(gapAnalysis).toHaveBeenCalledTimes(1));

    expect(await screen.findByText(/DRS escalation ladder/)).toBeInTheDocument();
    expect(screen.getByText(/Predicted break point/)).toBeInTheDocument();
    expect(screen.getByText('combo')).toBeInTheDocument(); // combination line flagged
    expect(screen.getByText('break point')).toBeInTheDocument(); // break-point tag on the row
  });

  it('shows the no-gap banner when there is no break point', async () => {
    gapAnalysis.mockResolvedValue({ ...ANALYSIS, breakPoint: null });
    render(<GapPlannerSection />);
    fireEvent.click(screen.getByRole('button', { name: /Analyze gaps/ }));
    await waitFor(() => expect(screen.getByText(/No gap on the ladder/)).toBeInTheDocument());
  });

  it('surfaces an error through app.push when the analysis fails', async () => {
    gapAnalysis.mockRejectedValue(new Error('boom'));
    render(<GapPlannerSection />);
    fireEvent.click(screen.getByRole('button', { name: /Analyze gaps/ }));
    await waitFor(() => expect(fakeApp.push).toHaveBeenCalledWith('error', 'boom'));
  });
});
