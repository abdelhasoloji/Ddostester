import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi({
  benchScenarios: vi.fn().mockResolvedValue({
    scenarios: [
      {
        id: 'udp_dns_reflection',
        title: 'UDP DNS Reflection',
        proto: 'UDP',
        drs: 3,
        reproducible: true,
        note: 'Synthetic DNS-shape amplification.',
      },
      {
        id: 'tcp_synflood',
        title: 'TCP SynFlood',
        proto: 'TCP',
        drs: 3,
        reproducible: false,
        note: 'Stateful spoofable TCP flood — out of model.',
      },
      {
        id: 'ip_spoofing',
        title: 'IP Spoofing',
        proto: 'IP',
        drs: 4,
        reproducible: false,
        note: 'Spoofing is never permitted here.',
      },
      {
        id: 'udp_multivector',
        title: 'UDP MultiVector',
        proto: 'UDP',
        drs: 4,
        reproducible: true,
        note: 'Several UDP profiles together.',
      },
    ],
    dispatchEnabled: true,
    labTargets: ['lab-target.internal'],
  }),
  benchRuns: vi.fn().mockResolvedValue({
    runs: [
      {
        id: 'b1',
        scenario: 'udp_dns_reflection',
        labTarget: 'lab-target.internal',
        status: 'COMPLETED',
        requestedBy: 'ciso@wedos',
        requestedAt: new Date().toISOString(),
        verdict: {
          schema: 'shieldtest.lab.verdict/v1',
          class: 'C',
          outcome: 'UNMITIGATED_BASELINE',
          amplificationFactor: 40,
          mitigation: null,
        },
      },
    ],
  }),
  createBenchRun: vi
    .fn()
    .mockResolvedValue({ id: 'b2', scenario: 'udp_dns_reflection', status: 'REQUESTED' }),
  benchCoverage: vi.fn().mockResolvedValue({
    coverage: [
      {
        id: 'cov1',
        vector: 'ip_spoofing',
        method: 'ATTESTED',
        outcome: 'PASS',
        summary: 'Edge enforces BCP38/uRPF.',
        source: 'edge-config',
        recordedBy: 'ciso@wedos',
        at: new Date().toISOString(),
      },
    ],
  }),
  recordBenchCoverage: vi.fn().mockResolvedValue({ id: 'cov2' }),
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
const { BenchCard } = await import('./bench-card.js');
const { RunTheaterPage } = await import('./run-theater.js');

describe('Network bench cockpit (Settings) — DRS matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentApp = makeApp({
      role: 'ciso',
      authRequired: true,
      identity: { email: 'ciso@wedos', role: 'ciso' },
    });
  });

  it('opens the existing governed synthetic cockpit in Run Theater without an HTTP run', async () => {
    renderWithRouter(<RunTheaterPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Synthetic bench' }));
    expect(await screen.findByText(/Network bench — advanced · class C/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Aggregate report' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Report' })).toHaveAttribute(
      'href',
      '/api/bench/runs/b1/report',
    );
    expect(fakeApi.createBenchRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Request run/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Choose a template' })).toHaveAttribute(
      'href',
      '/campaigns?tab=templates#synthetic',
    );
  });

  it('refreshes coverage with the terminal verdict without a page reload', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    fakeApi.benchRuns.mockResolvedValueOnce({
      runs: [{ id: 'pending', scenario: 'udp_dns_reflection', status: 'CLAIMED' }],
    });
    fakeApi.benchCoverage.mockResolvedValueOnce({ coverage: [] }).mockResolvedValueOnce({
      coverage: [
        {
          id: 'live',
          vector: 'udp_dns_reflection',
          method: 'MEASURED_LAB',
          outcome: 'UNMITIGATED_BASELINE',
          summary: 'Live receiver evidence',
          source: 'runner',
          at: new Date().toISOString(),
        },
      ],
    });
    try {
      renderWithRouter(<BenchCard />);
      await screen.findByText('Claimed');
      await waitFor(() => expect(fakeApi.benchCoverage).toHaveBeenCalledTimes(1));
      const tick = timer.mock.calls.find((call) => call[1] === 4000)?.[0];
      expect(typeof tick).toBe('function');
      await act(async () => {
        await (tick as () => Promise<void>)();
      });
      expect(await screen.findByText('Measured lab')).toBeTruthy();
      expect(screen.getByText('Completed')).toBeTruthy();
      expect(fakeApi.benchCoverage).toHaveBeenCalledTimes(2);
      const pollingIndex = timer.mock.calls.findIndex((call) => call[1] === 4000);
      // A terminal run can precede its coverage write. Do not stop polling here.
      expect(clear).not.toHaveBeenCalledWith(timer.mock.results[pollingIndex].value);
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  it('shows the CISO the DRS coverage matrix and a completed verdict', async () => {
    renderWithRouter(<BenchCard />);
    expect(await screen.findByText(/Network bench — advanced · class C/)).toBeTruthy();
    expect(await screen.findByText(/DRS Volumetric coverage/)).toBeTruthy();
    // Out-of-model vectors are shown for coverage.
    expect(await screen.findByText('tcp_synflood')).toBeTruthy();
    expect(screen.getByText('ip_spoofing')).toBeTruthy();
    expect(screen.getAllByText('out of model').length).toBeGreaterThanOrEqual(2);
    // A completed verdict is displayed read-only.
    expect(screen.getByText('Unmitigated baseline')).toBeTruthy();
    expect(screen.getByText('40×')).toBeTruthy();
  });

  it('only offers reproducible vectors for dispatch', async () => {
    renderWithRouter(<BenchCard />);
    const select = (await screen.findByLabelText(/Reproducible vector/)) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('udp_dns_reflection');
    expect(values).toContain('udp_multivector');
    expect(values).not.toContain('tcp_synflood'); // out of model → not dispatchable
    expect(values).not.toContain('ip_spoofing');
  });

  it('dispatches a governed run on click', async () => {
    renderWithRouter(<BenchCard />);
    const btn = await screen.findByText(/Request run/);
    fireEvent.click(btn);
    await waitFor(() => expect(fakeApi.createBenchRun).toHaveBeenCalledWith('udp_dns_reflection'));
  });

  it('shows the coverage method for an out-of-model vector and records new evidence', async () => {
    renderWithRouter(<BenchCard />);
    // ip_spoofing is covered by ATTESTED evidence (not a run).
    expect(await screen.findByText('Attested')).toBeTruthy();
    // Open the record-coverage form and submit.
    fireEvent.click(await screen.findByText(/Record coverage evidence/));
    fireEvent.change(await screen.findByPlaceholderText(/BCP38/), {
      target: { value: 'GRE dropped at the edge router.' },
    });
    fireEvent.click(screen.getByText('Record coverage'));
    await waitFor(() => expect(fakeApi.recordBenchCoverage).toHaveBeenCalled());
  });

  it('hides the bench cockpit from profiles without bench capabilities', async () => {
    currentApp = makeApp({
      role: 'viewer',
      authRequired: true,
      identity: { email: 'off@wedos', role: 'viewer' },
    });
    renderWithRouter(<SettingsPage />);
    await screen.findByText(/Engine & security/);
    expect(screen.queryByText(/Network bench — advanced · class C/)).toBeNull();
    expect(fakeApi.benchScenarios).not.toHaveBeenCalled();
  });
});
