import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi() as ReturnType<typeof makeApi> & {
  executeDrsPlan: ReturnType<typeof vi.fn>;
};
fakeApi.executeDrsPlan = vi.fn();

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
