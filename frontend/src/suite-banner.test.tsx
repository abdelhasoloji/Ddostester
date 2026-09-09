import { describe, expect, it, vi, beforeEach } from 'vitest';
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

const { SuiteRunBanner, groupSuites, stepLabel } = await import('./pages.js');

/** Minimal suite member factory. */
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

describe('groupSuites', () => {
  it('groups suite members, counts progress and finds the current step', () => {
    const groups = groupSuites([
      member(0, 'COMPLETED'),
      member(1, 'RUNNING'),
      member(2, 'APPROVED'),
      { ...member(9, 'COMPLETED'), suiteId: undefined, suiteName: undefined }, // non-suite → ignored
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.total).toBe(3);
    expect(g.done).toBe(1);
    expect(g.running).toBe(1);
    expect(g.remaining).toBe(2);
    // Current step is the RUNNING one.
    expect(g.current?.suiteOrder).toBe(1);
  });

  it('picks the first non-terminal step as current when nothing is running', () => {
    const g = groupSuites([
      member(0, 'COMPLETED'),
      member(1, 'PENDING_APPROVAL'),
      member(2, 'APPROVED'),
    ])[0];
    expect(g.running).toBe(0);
    expect(g.pending).toBe(1);
    expect(g.current?.suiteOrder).toBe(1);
  });
});

describe('stepLabel', () => {
  it('strips the "<suite> — " prefix, leaves other names intact', () => {
    expect(stepLabel(member(0, 'APPROVED', { name: 'Suite X — GET flood' }), 'Suite X')).toBe(
      'GET flood',
    );
    expect(stepLabel(member(0, 'APPROVED', { name: 'Standalone' }), 'Suite X')).toBe('Standalone');
  });
});

describe('SuiteRunBanner', () => {
  beforeEach(() => {
    fakeApi.runSuite = vi.fn().mockResolvedValue({ suiteId: 'suite-1', steps: 2, started: true });
    fakeApi.pauseSuite = vi.fn().mockResolvedValue({ suiteId: 'suite-1', paused: true });
    fakeApi.resumeSuite = vi.fn().mockResolvedValue({ suiteId: 'suite-1', paused: false });
    fakeApi.cancelSuite = vi
      .fn()
      .mockResolvedValue({ suiteId: 'suite-1', cancelled: true, killedCurrent: true });
    fakeApi.suiteSequences = vi.fn().mockResolvedValue({ sequences: {} });
  });

  it('renders nothing when there is no in-flight suite', () => {
    currentApp = makeApp({ campaigns: [member(0, 'COMPLETED'), member(1, 'COMPLETED')] });
    const { container } = renderWithRouter(<SuiteRunBanner />);
    expect(container.querySelector('.suite-banner')).toBeNull();
  });

  it('shows the single approve-and-run action and calls runSuite once', async () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'officer',
      campaigns: [
        member(0, 'COMPLETED'),
        member(1, 'PENDING_APPROVAL'),
        member(2, 'PENDING_APPROVAL'),
      ],
    });
    renderWithRouter(<SuiteRunBanner />);
    // Progress line reflects 1/3 done.
    expect(screen.getByText(/1\/3 steps done/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Approve & run whole scenario/ });
    fireEvent.click(btn);
    await waitFor(() => expect(fakeApi.runSuite).toHaveBeenCalledTimes(1));
    expect(fakeApi.runSuite).toHaveBeenCalledWith('suite-1');
  });

  it('shows Pause + Cancel while a step is running, and surfaces the current step', () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'officer',
      campaigns: [member(0, 'COMPLETED'), member(1, 'RUNNING'), member(2, 'APPROVED')],
    });
    renderWithRouter(<SuiteRunBanner />);
    // A running sequence is controllable, not just a disabled "run" button.
    expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull();
    expect(screen.getByText(/Running step 2\/3:/)).toBeInTheDocument();
  });

  it('pauses a running sequence via api.pauseSuite', async () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'officer',
      campaigns: [member(0, 'COMPLETED'), member(1, 'RUNNING'), member(2, 'APPROVED')],
    });
    renderWithRouter(<SuiteRunBanner />);
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(fakeApi.pauseSuite).toHaveBeenCalledWith('suite-1'));
  });

  it('cancels a running sequence via api.cancelSuite', async () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'officer',
      campaigns: [member(0, 'COMPLETED'), member(1, 'RUNNING'), member(2, 'APPROVED')],
    });
    renderWithRouter(<SuiteRunBanner />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(fakeApi.cancelSuite).toHaveBeenCalledWith('suite-1'));
  });

  it('shows Resume when the live sequence state reports paused', async () => {
    fakeApi.suiteSequences = vi
      .fn()
      .mockResolvedValue({ sequences: { 'suite-1': { paused: true, started: 1, total: 3 } } });
    currentApp = makeApp({
      authRequired: true,
      role: 'officer',
      campaigns: [member(0, 'COMPLETED'), member(1, 'APPROVED'), member(2, 'APPROVED')],
    });
    renderWithRouter(<SuiteRunBanner />);
    // The sequence state is fetched async; the Resume control + paused note appear.
    await waitFor(() => expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument());
    expect(screen.getByText(/Paused — holding before the next step/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    await waitFor(() => expect(fakeApi.resumeSuite).toHaveBeenCalledWith('suite-1'));
  });

  it('hides the run action for a viewer (no approve permission)', () => {
    currentApp = makeApp({
      authRequired: true,
      role: 'viewer',
      campaigns: [member(0, 'PENDING_APPROVAL'), member(1, 'PENDING_APPROVAL')],
    });
    renderWithRouter(<SuiteRunBanner />);
    expect(screen.queryByRole('button', { name: /Approve & run/ })).toBeNull();
    // But the progress banner still renders (visibility for all roles).
    expect(screen.getByText(/0\/2 steps done/)).toBeInTheDocument();
  });
});
