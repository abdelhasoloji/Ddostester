import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign } from './api.js';

const fakeApi = makeApi();
const drsClients = fakeApi.drsClients as unknown as ReturnType<typeof vi.fn>;
const drsCampaignReport = fakeApi.drsCampaignReport as unknown as ReturnType<typeof vi.fn>;

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { OverviewPage } = await import('./overview-page.js');

const campaign = (over: Partial<Campaign> = {}) =>
  ({
    id: 'c1',
    name: 'DRS L1 — acme',
    target: 'https://pay.acme.eu',
    status: 'PENDING_APPROVAL',
    drsDocument: {
      currentRevision: 1,
      revisions: [
        {
          number: 1,
          id: 'r1',
          state: 'FINAL_REPORT',
          plan: { mode: 'measured', maxLevel: 1 },
          proofs: [],
          trace: [],
          finalizedAt: '2026-10-21T10:00:00.000Z',
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

describe('overview', () => {
  it('shows the posture, the running exposure with a stop control and the latest verdict', async () => {
    currentApp = makeApp({
      campaigns: [
        campaign(),
        campaign({
          id: 'c2',
          name: 'DRS L1 — running',
          drsDocument: {
            currentRevision: 1,
            revisions: [
              {
                number: 1,
                id: 'r2',
                state: 'LEVEL_EXECUTION',
                plan: { mode: 'measured', maxLevel: 1 },
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
        }),
      ],
    });
    drsClients.mockResolvedValue({ clients: [] });
    drsCampaignReport.mockResolvedValue({
      assessment: {
        status: 'PARTIAL',
        requirementGaps: [
          {
            vectorId: 'v1',
            level: 1,
            dimension: 'load',
            required: '500 tps',
            achieved: '20 tps',
            met: false,
          },
          {
            vectorId: 'v1',
            level: 1,
            dimension: 'sources',
            required: '10 bots',
            achieved: '10 bots',
            met: true,
          },
        ],
      },
    });
    renderWithRouter(<OverviewPage />);
    expect(await screen.findByText(/Coverage by DRS level/)).toBeTruthy();
    expect(await screen.findByText(/Stop the exposure/)).toBeTruthy();
    // stopping is destructive: it asks once before aborting
    fireEvent.click(screen.getByText(/Stop the exposure/));
    expect(screen.getByText(/Confirm stop/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/PARTIAL/).length).toBeGreaterThan(0));
    // one of two requirements reached → the level bar says 1 / 2
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });
});
