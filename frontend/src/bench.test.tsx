import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi({
  benchScenarios: vi.fn().mockResolvedValue({
    scenarios: [
      {
        name: 'amplification-ramp',
        summary: 'Byte+packet amplification ramping up.',
        useScrubber: false,
      },
      { name: 'blocklist-mitigation', summary: 'Signature-style blocklist.', useScrubber: true },
    ],
    dispatchEnabled: true,
    labTargets: ['lab-target.internal'],
  }),
  benchRuns: vi.fn().mockResolvedValue({
    runs: [
      {
        id: 'b1',
        scenario: 'amplification-ramp',
        labTarget: 'lab-target.internal',
        status: 'COMPLETED',
        requestedBy: 'ciso@wedos',
        requestedAt: new Date().toISOString(),
        verdict: {
          schema: 'shieldtest.lab.verdict/v1',
          class: 'C',
          outcome: 'UNMITIGATED_BASELINE',
          amplificationFactor: 20,
          mitigation: null,
        },
      },
    ],
  }),
  createBenchRun: vi
    .fn()
    .mockResolvedValue({ id: 'b2', scenario: 'amplification-ramp', status: 'REQUESTED' }),
});

vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});

const { SettingsPage } = await import('./pages.js');

describe('Network bench cockpit (Settings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentApp = makeApp({
      role: 'ciso',
      authRequired: true,
      identity: { email: 'ciso@wedos', role: 'ciso' },
    });
  });

  it('shows the CISO the bench cockpit with runs and verdicts', async () => {
    renderWithRouter(<SettingsPage />);
    expect(await screen.findByText(/Network bench — class C/)).toBeTruthy();
    // Verdict evidence from a completed run is displayed read-only.
    expect(await screen.findByText('UNMITIGATED_BASELINE')).toBeTruthy();
    expect(screen.getByText('20×')).toBeTruthy();
  });

  it('dispatches a governed run request on click', async () => {
    renderWithRouter(<SettingsPage />);
    const btn = await screen.findByText(/Request run/);
    fireEvent.click(btn);
    await waitFor(() => expect(fakeApi.createBenchRun).toHaveBeenCalledWith('amplification-ramp'));
  });

  it('hides the bench cockpit from non-CISO roles', async () => {
    currentApp = makeApp({
      role: 'officer',
      authRequired: true,
      identity: { email: 'off@wedos', role: 'officer' },
    });
    renderWithRouter(<SettingsPage />);
    // Settings still renders (engine card is always present) but the bench is gone.
    await screen.findByText(/Engine & security/);
    expect(screen.queryByText(/Network bench — class C/)).toBeNull();
    expect(fakeApi.benchScenarios).not.toHaveBeenCalled();
  });
});
