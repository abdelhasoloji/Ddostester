import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi() as ReturnType<typeof makeApi> & {
  executeDrsPlan: ReturnType<typeof vi.fn>;
  replayDrsPlan: ReturnType<typeof vi.fn>;
  cancelDrsPlan: ReturnType<typeof vi.fn>;
  drsCampaignReport: ReturnType<typeof vi.fn>;
};
fakeApi.executeDrsPlan = vi.fn();
fakeApi.replayDrsPlan = vi.fn();
fakeApi.cancelDrsPlan = vi.fn();
fakeApi.drsCampaignReport = vi.fn();

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { DrsPage } = await import('./drs-page.js');

const drsCampaign = (over: Partial<Campaign> = {}): Campaign =>
  ({
    id: 'c1',
    name: 'DRS L1 — staging',
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/',
    status: 'PENDING_APPROVAL',
    vector: 'http-get',
    drsDocument: {
      currentRevision: 1,
      revisions: [
        {
          number: 1,
          id: 'r1',
          state: 'PLAN_FROZEN',
          plan: { maxLevel: 2, mode: 'measured' },
          proofs: [],
          trace: [],
          reference: {
            standardVersion: '3.00.00',
            engineVersion: 'e',
            catalogueHash: 'h',
            interpretationProfile: 'i',
          },
        },
      ],
    },
    ...over,
  }) as unknown as Campaign;

beforeEach(() => {
  fakeApi.executeDrsPlan.mockReset();
  fakeApi.drsCampaignReport.mockReset();
  fakeApi.replayDrsPlan.mockReset();
  fakeApi.cancelDrsPlan.mockReset();
});

describe('DRS workspace', () => {
  it('lists a frozen plan with its mode, level and report links', () => {
    currentApp = makeApp({ campaigns: [drsCampaign()] });
    renderWithRouter(<DrsPage />);
    expect(screen.getByText('DRS L1 — staging')).toBeTruthy();
    expect(screen.getByText('measured')).toBeTruthy();
    expect(screen.getByText('DRS 2')).toBeTruthy();
    expect(screen.getByText('PLAN_FROZEN')).toBeTruthy();
    expect(screen.getByText('report')).toHaveAttribute(
      'href',
      expect.stringContaining('/drs/report.html'),
    );
  });

  it('starts an execution and reports it', async () => {
    const campaign = drsCampaign();
    currentApp = makeApp({ campaigns: [campaign] });
    fakeApi.executeDrsPlan.mockResolvedValue({ campaignId: 'c1', started: true, maxLevel: 2 });
    renderWithRouter(<DrsPage />);
    fireEvent.click(screen.getByRole('button', { name: /execute/i }));
    await waitFor(() => expect(fakeApi.executeDrsPlan).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(currentApp.push).toHaveBeenCalledWith('success', expect.stringContaining('started')),
    );
  });

  it('hides the execute button once the revision is finalized', () => {
    const done = drsCampaign();
    (done.drsDocument!.revisions[0] as unknown as { finalizedAt: string }).finalizedAt =
      '2026-10-19T20:00:00.000Z';
    currentApp = makeApp({ campaigns: [done] });
    renderWithRouter(<DrsPage />);
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
    expect(screen.getByText(/finalized/)).toBeTruthy();
  });

  it('points to Capacity when no plan exists', () => {
    currentApp = makeApp({ campaigns: [] });
    renderWithRouter(<DrsPage />);
    expect(screen.getByText(/No DRS plan yet/)).toBeTruthy();
  });
});

describe('DRS verdict and requirement gaps', () => {
  it('shows the assessment and the unmet requirement when a report exists', async () => {
    const done = drsCampaign();
    (done.drsDocument!.revisions[0] as unknown as { finalizedAt: string }).finalizedAt =
      '2026-10-19T20:00:00.000Z';
    currentApp = makeApp({ campaigns: [done] });
    fakeApi.drsCampaignReport.mockResolvedValue({
      revision: 1,
      reference: {
        standardVersion: '3.00.00',
        engineVersion: 'e',
        catalogueHash: 'h',
        interpretationProfile: 'i',
      },
      assessment: {
        label: 'Measured DRS assessment',
        status: 'PARTIAL',
        score: null,
        terminalLevel: 1,
        terminalOutcome: 'PARTIAL',
        reservations: [],
        levels: [],
        requirementGaps: [
          {
            vectorId: 'drs-3.00.00-151002',
            level: 1,
            dimension: 'sources',
            required: '1000 independent bots',
            achieved: '1 observed source(s), 1 generator(s)',
            met: false,
          },
        ],
      },
    });
    renderWithRouter(<DrsPage />);
    expect(await screen.findByText(/PARTIAL · PARTIAL/)).toBeTruthy();
    fireEvent.click(screen.getByText('DRS L1 — staging'));
    expect(await screen.findByText('1000 independent bots')).toBeTruthy();
    expect(screen.getByText('no')).toBeTruthy();
  });
});

describe('replay', () => {
  it('clones a plan into a new campaign and reports it', async () => {
    currentApp = makeApp({ campaigns: [drsCampaign()] });
    fakeApi.replayDrsPlan.mockResolvedValue({ id: 'c2', name: 'DRS L1 — staging (replay)' });
    renderWithRouter(<DrsPage />);
    fireEvent.click(screen.getByRole('button', { name: /^replay$/i }));
    await waitFor(() => expect(fakeApi.replayDrsPlan).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(currentApp.push).toHaveBeenCalledWith('success', expect.stringContaining('(replay)')),
    );
  });
});

describe('kill switch', () => {
  it('offers Cancel on a running assessment and calls the route', async () => {
    const running = drsCampaign();
    (running.drsDocument!.revisions[0] as unknown as { state: string }).state = 'LEVEL_EXECUTION';
    currentApp = makeApp({ campaigns: [running] });
    fakeApi.cancelDrsPlan.mockResolvedValue({ campaignId: 'c1', cancelling: true });
    renderWithRouter(<DrsPage />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(fakeApi.cancelDrsPlan).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(currentApp.push).toHaveBeenCalledWith(
        'success',
        expect.stringContaining('Cancellation'),
      ),
    );
  });

  it('does not offer Cancel on a frozen plan that has not started', () => {
    currentApp = makeApp({ campaigns: [drsCampaign()] });
    renderWithRouter(<DrsPage />);
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });
});
