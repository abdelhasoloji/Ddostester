import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsCampaign = fakeApi.drsCampaign as unknown as ReturnType<typeof vi.fn>;
const drsCampaignReport = fakeApi.drsCampaignReport as unknown as ReturnType<typeof vi.fn>;
const listCampaigns = fakeApi.listCampaigns as unknown as ReturnType<typeof vi.fn>;

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { AssessmentPage } = await import('./assessment-page.js');

const revision = (state: string, mode: string, extra: Record<string, unknown> = {}) => ({
  number: 1,
  id: 'r1',
  state,
  plan: { mode, maxLevel: 1, exposureSec: 60 },
  proofs: [],
  trace: [
    { state: 'PLAN_FROZEN', at: '2026-10-20T10:00:00.000Z', detail: 'frozen' },
    { state, at: '2026-10-20T10:01:00.000Z', detail: 'done' },
  ],
  reference: {
    standardVersion: '3.00.00',
    engineVersion: 'e',
    catalogueHash: 'h',
    interpretationProfile: 'i',
  },
  ...extra,
});

beforeEach(() => {
  currentApp = makeApp();
  listCampaigns.mockResolvedValue([
    { id: 'c1', name: 'DRS L1 — acme', target: 'https://pay.acme.eu' },
  ]);
});

describe('assessment screen', () => {
  it('shows the synthetic validation and no verdict', async () => {
    drsCampaign.mockResolvedValue({
      document: { currentRevision: 1, revisions: [revision('ENGINE_VALIDATED', 'synthetic-lab')] },
      defaultPlan: {},
    });
    drsCampaignReport.mockResolvedValue({
      revision: 1,
      reference: {
        standardVersion: '3.00.00',
        engineVersion: 'e',
        catalogueHash: 'h',
        interpretationProfile: 'i',
      },
      assessment: null,
      synthetic: {
        schema: 'shieldtester.drs.synthetic/v1',
        claimed: { rps: 50, concurrency: 1, durationSec: 60 },
        produced: { rps: 49.8, concurrency: 1, durationSec: 60, requests: 2988, errors: 0 },
        fidelity: 0.996,
        controls: [{ id: 'rate', ok: true, detail: '49.8 rps produced against 50 rps claimed' }],
        sealedAt: '2026-10-21T08:07:30.000Z',
        hash: 'a'.repeat(64),
      },
    });
    renderWithRouter(<AssessmentPage />, { route: '/assessments/c1', path: '/assessments/:id' });
    expect(await screen.findByText(/Synthetic amplifier · non-certifying/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /evidence/i }));
    expect(screen.getByText(/Claimed versus produced/)).toBeTruthy();
    expect(screen.getByText(/Fidelity/)).toBeTruthy();
    expect(screen.queryByText(/Archived requirements/)).toBeNull();
  });

  it('shows the verdict, the observation points and the archived requirements for a measured run', async () => {
    drsCampaign.mockResolvedValue({
      document: {
        currentRevision: 1,
        revisions: [
          revision('FINAL_REPORT', 'measured', { finalizedAt: '2026-10-20T10:05:00.000Z' }),
        ],
      },
      defaultPlan: {},
    });
    drsCampaignReport.mockResolvedValue({
      revision: 1,
      reference: {
        standardVersion: '3.00.00',
        engineVersion: 'e',
        catalogueHash: 'h',
        interpretationProfile: 'i',
      },
      assessment: {
        label: 'Measured',
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
            required: '10 independent bots',
            achieved: '1 generator',
            met: false,
          },
        ],
      },
      proofs: [
        {
          id: 'p1',
          hash: 'h',
          provenance: 'sealed',
          data: {
            points: [
              {
                sourceId: 'generator',
                load: { value: 500, unit: 'tps' },
                sampleCount: 12,
                artifactHash: 'abc',
              },
              {
                sourceId: 'entry',
                load: { value: 481, unit: 'tps' },
                sampleCount: 2,
                artifactHash: 'def',
              },
            ],
            legitimate_transaction_success: [{ successful: 22, total: 22 }],
          },
        },
      ],
    });
    renderWithRouter(<AssessmentPage />, { route: '/assessments/c1', path: '/assessments/:id' });
    expect(await screen.findByText(/PARTIAL · terminal level 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /evidence/i }));
    expect(screen.getByText(/Observation points/)).toBeTruthy();
    expect(screen.getByText('entry')).toBeTruthy();
    expect(screen.getByText(/22\/22/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /requirements/i }));
    expect(screen.getByText(/10 independent bots/)).toBeTruthy();
  });
});
