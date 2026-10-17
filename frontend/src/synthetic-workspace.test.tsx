import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SyntheticWorkspace, SyntheticTheater } from './synthetic-workspace.js';
import { RunTheaterPage } from './run-theater.js';
import { api, type SyntheticView, type DrsSequencePlan } from './api.js';
import { makeApp } from './test-utils.js';
let app = makeApp();
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
const reference = {
  schema: 'plan',
  targetLevel: 5,
  intervalSec: 2,
  catalogueHash: 'catalogue',
  planHash: 'reference-hash',
  executable: 1,
  blocked: 1,
  measuredLevel: null,
  rows: [
    {
      id: 'one',
      name: 'UDP',
      level: 5,
      supported: false,
      sourceVectorId: 'source',
      ambiguityCount: 0,
      reason: 'partial',
      laboratory: {
        scenarioId: 'udp_maxpackets',
        mode: 'synthetic-lab',
        qualification: 'partial-shape',
        representedDimensions: ['shape'],
        missingDimensions: ['protocol'],
        scoreEligible: false,
      },
    },
  ],
} as const;
const snapshot = (
  state: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'COMPLETED' = 'DRAFT',
): SyntheticView => ({
  campaign: {
    id: 'campaign',
    name: 'Bounded QA',
    createdBy: 'op',
    createdAt: '2026-10-17T00:00:00Z',
    status:
      state === 'COMPLETED' ? 'COMPLETED' : state === 'DRAFT' ? 'PENDING_APPROVAL' : 'RUNNING',
    target: 'http://lab-target/',
    probeUrl: 'http://lab-target/',
    vector: 'http-get',
    maxRps: 3,
    concurrency: 1,
    maxDurationSec: 60,
    syntheticJourney: {
      schema: 'journey',
      state,
      definition: {
        schema: 'definition',
        reference: structuredClone(reference) as unknown as DrsSequencePlan,
        labTarget: 'lab-target',
        scenarios: ['udp_maxpackets'],
      },
      planHash: 'reviewed-hash',
      steps: [{ scenarioId: 'udp_maxpackets', runId: state === 'DRAFT' ? undefined : 'run' }],
    },
    drsDocument:
      state === 'COMPLETED'
        ? ({
            currentRevision: 1,
            revisions: [{ number: 1, id: 'rev', finalizedAt: '2026-10-17T00:00:10Z' }],
          } as SyntheticView['campaign']['drsDocument'])
        : undefined,
  },
  runs: [
    state === 'DRAFT'
      ? null
      : {
          id: 'run',
          scenario: 'udp_maxpackets',
          labTarget: 'lab-target',
          status: state === 'COMPLETED' ? 'COMPLETED' : 'CLAIMED',
          requestedBy: 'op',
          requestedAt: '2026-10-17T00:00:00Z',
          verdict:
            state === 'COMPLETED'
              ? { schema: 'v1', class: 'C', target: { packets: 100, avgBps: 2000000 } }
              : undefined,
        },
  ],
});
beforeEach(() => {
  app = makeApp({ role: 'admin', authRequired: true, userMode: 'single' });
  vi.spyOn(api, 'benchScenarios').mockResolvedValue({
    scenarios: [],
    dispatchEnabled: true,
    labTargets: ['lab-target'],
  });
  vi.spyOn(api, 'drsSequencePlan').mockResolvedValue(
    structuredClone(reference) as unknown as Awaited<ReturnType<typeof api.drsSequencePlan>>,
  );
  vi.spyOn(api, 'syntheticCampaign').mockResolvedValue(snapshot());
  vi.spyOn(api, 'syntheticControl').mockResolvedValue(snapshot('RUNNING').campaign);
});
afterEach(() => vi.restoreAllMocks());
it('creates a bounded draft then requires explicit reviewed launch confirmation', async () => {
  const create = vi.spyOn(api, 'createSyntheticCampaign').mockResolvedValue(snapshot().campaign);
  render(
    <MemoryRouter>
      <SyntheticWorkspace />
    </MemoryRouter>,
  );
  await screen.findByText(/1 registered synthetic shapes/);
  fireEvent.click(screen.getByLabelText(/I authorize/));
  fireEvent.click(screen.getByRole('button', { name: 'Create synthetic campaign' }));
  await screen.findByRole('button', { name: 'Review and launch synthetic campaign' });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      targetLevel: 5,
      intervalSec: 2,
      labTarget: 'lab-target',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review and launch synthetic campaign' }));
  const launch = screen.getByRole('button', { name: 'Launch bounded synthetic campaign' });
  expect(launch).toBeDisabled();
  expect(api.syntheticControl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/I confirm this frozen/));
  fireEvent.click(launch);
  await waitFor(() =>
    expect(api.syntheticControl).toHaveBeenCalledWith('campaign', 'start', {
      confirmed: true,
      planHash: 'reviewed-hash',
    }),
  );
});
it('routes an explicit synthetic theater selection without a legacy campaign-run or suite', async () => {
  vi.mocked(api.syntheticCampaign).mockResolvedValue(snapshot('RUNNING'));
  render(
    <MemoryRouter initialEntries={['/theater?synthetic=campaign']}>
      <RunTheaterPage />
    </MemoryRouter>,
  );
  await screen.findByRole('region', { name: 'Synthetic Run Theater' });
  expect(screen.queryByText(/No run in flight/)).not.toBeInTheDocument();
  expect(screen.getByText('CLAIMED')).toBeInTheDocument();
  expect(screen.getByText('Awaiting runner observation')).toBeInTheDocument();
});
it('shows honest final received counters and both report exports', async () => {
  vi.mocked(api.syntheticCampaign).mockResolvedValue(snapshot('COMPLETED'));
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: 'Open final report' })).toHaveAttribute(
    'href',
    '/api/campaigns/campaign/drs/report.html',
  );
  expect(screen.getByText('2.00 Mbit/s received')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download report JSON' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stop synthetic campaign' })).not.toBeInTheDocument();
});
it('allows stop while pause is pending and exposes bounded settling semantics', async () => {
  let resolve!: () => void;
  vi.mocked(api.syntheticCampaign).mockResolvedValue(snapshot('RUNNING'));
  vi.mocked(api.syntheticControl).mockImplementation(async (_id, action) => {
    if (action === 'pause')
      await new Promise<void>((r) => {
        resolve = r;
      });
    if (action === 'stop') vi.mocked(api.syntheticCampaign).mockResolvedValue(snapshot('STOPPING'));
    return snapshot('STOPPING').campaign;
  });
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Pause synthetic campaign' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop synthetic campaign' }));
  await screen.findByText(/Waiting for the current bounded scenario/);
  expect(api.syntheticControl).toHaveBeenCalledWith('campaign', 'stop', undefined);
  resolve();
});
it('keeps viewers read-only while retaining finalized reports', async () => {
  app = makeApp({ role: 'viewer', authRequired: true });
  vi.mocked(api.syntheticCampaign).mockResolvedValue(snapshot('COMPLETED'));
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Open final report' });
  expect(
    screen.queryByRole('button', { name: /Pause|Stop|Launch|Resume/ }),
  ).not.toBeInTheDocument();
});
