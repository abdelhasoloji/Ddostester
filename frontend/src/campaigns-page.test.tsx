import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const { CampaignList } = await import('./pages.js');

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

/** Everything (suites included) is a compact table row now — click the row whose
 *  text contains `name` to expand it into its detail (the suite/campaign card). */
function expandRow(name: string) {
  const row = Array.from(document.querySelectorAll('tr.ct-row')).find((r) =>
    r.textContent?.includes(name),
  );
  fireEvent.click(row!);
}

describe('CampaignList — suite grouping', () => {
  it('renders a suite as one group with progress, aggregate WRS and timing', () => {
    currentApp = makeApp({
      role: 'ciso',
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
    renderWithRouter(<CampaignList />);
    // The compact suite ROW: name, step count and done-progress.
    expect(screen.getByText(/Suite X/)).toBeInTheDocument();
    expect(screen.getByText(/2 steps/)).toBeInTheDocument();
    expect(screen.getByText(/Done 2\/2/)).toBeInTheDocument();
    // Expanding the row reveals the suite card with the aggregate WRS + timing.
    expandRow('Suite X');
    expect(screen.getByText(/avg 75 · worst 60/)).toBeInTheDocument();
    expect(screen.getByText(/on target/)).toBeInTheDocument(); // Σ 4m on target
  });

  it('collapses done suites and expands to show per-step cards on toggle', () => {
    currentApp = makeApp({
      role: 'ciso',
      campaigns: [
        member(0, 'COMPLETED', { wrs: wrs(90) }),
        member(1, 'COMPLETED', { wrs: wrs(80) }),
      ],
    });
    renderWithRouter(<CampaignList />);
    // Collapsed row: the suite card isn't mounted at all yet.
    expect(document.querySelector('.suite-group')).toBeNull();
    expandRow('Suite X'); // expand the table row → the suite card appears (collapsed)
    expect(document.querySelector('.suite-group')).not.toBeNull();
    expect(document.querySelector('.suite-group-members')).toBeNull();
    // Its own toggle then reveals the per-step cards.
    fireEvent.click(screen.getByRole('button', { name: /Suite X/ }));
    expect(document.querySelector('.suite-group-members')).not.toBeNull();
  });

  it('archives a whole suite via app.archiveSuite', async () => {
    currentApp = makeApp({
      role: 'ciso',
      campaigns: [
        member(0, 'COMPLETED', { wrs: wrs(90) }),
        member(1, 'COMPLETED', { wrs: wrs(80) }),
      ],
    });
    renderWithRouter(<CampaignList />);
    expandRow('Suite X'); // the whole-suite Archive lives in the expanded suite card
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(currentApp.archiveSuite).toHaveBeenCalledWith('suite-1', 'Suite X', true),
    );
  });

  it('hides archived campaigns until the toggle is enabled', async () => {
    currentApp = makeApp({
      role: 'ciso',
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
    renderWithRouter(<CampaignList />);
    expect(screen.getByText('Live one')).toBeInTheDocument();
    expect(screen.queryByText('Archived one')).toBeNull();
    // Enable "Archived" toggle → the archived card appears.
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('Archived one')).toBeInTheDocument());
  });

  it('a CISO approves a pending scenario via the Approve/Reject modal (aligned with a basic campaign)', async () => {
    fakeApi.approveSuite = vi
      .fn()
      .mockResolvedValue({ suiteId: 'suite-1', approved: 2, skipped: 0 });
    currentApp = makeApp({
      role: 'ciso',
      authRequired: true,
      campaigns: [member(0, 'PENDING_APPROVAL'), member(1, 'PENDING_APPROVAL')],
    });
    renderWithRouter(<CampaignList />);
    expandRow('Suite X');
    // The suite offers the SAME "Approve / Reject" action a basic campaign does.
    fireEvent.click(screen.getByRole('button', { name: /Approve \/ Reject/ }));
    // The modal opens; Approve batches over the pending steps.
    fireEvent.click(screen.getByRole('button', { name: /^Approve \(/ }));
    await waitFor(() => expect(fakeApi.approveSuite).toHaveBeenCalledWith('suite-1'));
  });

  it('a CISO rejects a pending scenario with a reason via the same modal', async () => {
    fakeApi.rejectSuite = vi
      .fn()
      .mockResolvedValue({ suiteId: 'suite-1', rejected: 2, skipped: 0 });
    currentApp = makeApp({
      role: 'ciso',
      authRequired: true,
      campaigns: [member(0, 'PENDING_APPROVAL'), member(1, 'PENDING_APPROVAL')],
    });
    renderWithRouter(<CampaignList />);
    expandRow('Suite X');
    fireEvent.click(screen.getByRole('button', { name: /Approve \/ Reject/ }));
    // Reject is disabled until a reason is given (mirrors a single campaign).
    const dialog = screen.getByRole('dialog', { name: /Approve or reject assessment/i });
    const reject = within(dialog).getByRole('button', { name: /^Reject \(/ });
    expect(reject).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'out of window' },
    });
    fireEvent.click(reject);
    await waitFor(() =>
      expect(fakeApi.rejectSuite).toHaveBeenCalledWith('suite-1', 'out of window'),
    );
  });

  it('an engineer runs an approved scenario from the suite group header (two-step)', async () => {
    fakeApi.runSuite = vi.fn().mockResolvedValue({ suiteId: 'suite-1', steps: 2, started: true });
    currentApp = makeApp({
      role: 'engineer',
      authRequired: true,
      campaigns: [member(0, 'APPROVED'), member(1, 'APPROVED')],
    });
    renderWithRouter(<CampaignList />);
    expandRow('Suite X');
    const btn = screen.getByRole('button', { name: /Run assessment/ });
    fireEvent.click(btn);
    await waitFor(() => expect(fakeApi.runSuite).toHaveBeenCalledWith('suite-1'));
  });

  it('standalone campaigns render as a compact table; a row expands to the full card', () => {
    currentApp = makeApp({
      role: 'ciso',
      campaigns: [
        { ...member(0, 'COMPLETED'), suiteId: undefined, suiteName: undefined, name: 'Alpha run' },
        { ...member(1, 'COMPLETED'), suiteId: undefined, suiteName: undefined, name: 'Bravo run' },
      ],
    });
    renderWithRouter(<CampaignList />);
    // Compact table with a sortable header and one row per campaign.
    expect(document.querySelector('.campaign-table')).not.toBeNull();
    expect(document.querySelectorAll('.ct-row').length).toBe(2);
    // Collapsed: no full campaign card is mounted yet.
    expect(document.querySelector('.ct-detail .campaign')).toBeNull();
    // Clicking a row expands it into the full CampaignCard (detail on demand).
    fireEvent.click(screen.getByText('Alpha run'));
    expect(document.querySelector('.ct-detail .campaign')).not.toBeNull();
  });

  it('the table header sorts the rows by name', () => {
    currentApp = makeApp({
      role: 'ciso',
      campaigns: [
        { ...member(0, 'COMPLETED'), suiteId: undefined, suiteName: undefined, name: 'Zulu' },
        { ...member(1, 'COMPLETED'), suiteId: undefined, suiteName: undefined, name: 'Alpha' },
      ],
    });
    renderWithRouter(<CampaignList />);
    const names = () =>
      Array.from(document.querySelectorAll('.ct-row .ct-name-txt')).map((n) => n.textContent);
    // Click the Name header → ascending A→Z.
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Alpha', 'Zulu']);
    // Click again → descending Z→A (the sort direction toggles).
    fireEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Zulu', 'Alpha']);
  });

  it('expands a suite into compact step rows (stripped labels, no card wall)', () => {
    currentApp = makeApp({
      role: 'ciso',
      campaigns: [
        member(0, 'COMPLETED', { name: 'Suite X — SlowLoris', wrs: wrs(90) }),
        member(1, 'COMPLETED', { name: 'Suite X — GET-Flood', wrs: wrs(80) }),
      ],
    });
    renderWithRouter(<CampaignList />);
    expandRow('Suite X'); // expand the table row → the suite card
    fireEvent.click(screen.getByRole('button', { name: /Suite X/ })); // then its own toggle
    // Compact rows, not full CampaignCards; the suite prefix is stripped.
    expect(document.querySelectorAll('.suite-step-row').length).toBe(2);
    expect(screen.getByText('SlowLoris')).toBeInTheDocument();
    expect(screen.getByText('GET-Flood')).toBeInTheDocument();
  });
});
