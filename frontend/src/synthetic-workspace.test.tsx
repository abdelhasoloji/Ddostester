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
  await screen.findByText(/1 lab measurements/);
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

it('keeps all 60 scenario identities visible and separates simulations from measured counters', async () => {
  const view = snapshot('COMPLETED'),
    j = view.campaign.syntheticJourney!;
  j.schema = 'shieldtester.synthetic-journey/v2';
  j.steps = Array.from({ length: 60 }, (_, i) => ({
    scenarioId: i < 15 ? 'udp_maxpackets' : 'reference-' + i,
    vectorId: 'vector-' + i,
    name: 'Scenario ' + i,
    level: i < 28 ? 4 : 5,
    execution: i < 15 ? ('LAB_MEASUREMENT' as const) : ('SIMULATION' as const),
    result: {
      kind: i < 15 ? ('LAB_MEASUREMENT' as const) : ('SIMULATION' as const),
      outcome: i < 15 ? 'OBSERVED' : 'REFERENCE_LIFECYCLE_REPLAYED',
      at: 'fixture',
      receivedBps: i < 15 ? 2000000 : null,
      drsScoreEligible: false as const,
    },
  }));
  j.definition.entries = j.steps.map((s) => ({
    vectorId: s.vectorId!,
    name: s.name!,
    level: s.level!,
    execution: s.execution!,
    scenarioId: s.scenarioId,
    referenceHash: 'fixture',
    referenceVector: {},
  }));
  view.runs = j.steps.map((_, i) =>
    i < 15 ? { ...snapshot('COMPLETED').runs[0]!, id: 'run-' + i } : null,
  );
  vi.mocked(api.syntheticCampaign).mockResolvedValue(view);
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByText(/60\/60 scenarios settled/);
  expect(screen.getByLabelText('Synthetic result counts')).toHaveTextContent(
    '15 measured · 45 simulated · 0 not evaluated',
  );
  expect(screen.getAllByText('Simulated lifecycle complete')).toHaveLength(45);
  fireEvent.change(screen.getByLabelText('Show scenarios'), { target: { value: 'SIMULATION' } });
  expect(screen.queryByText('2.00 Mbit/s received')).not.toBeInTheDocument();
  expect(screen.getAllByText('Simulated lifecycle complete')).toHaveLength(45);
  fireEvent.change(screen.getByLabelText('Show scenarios'), {
    target: { value: 'LAB_MEASUREMENT' },
  });
  expect(screen.getAllByText('2.00 Mbit/s received')).toHaveLength(15);
  expect(screen.queryByText('Simulated lifecycle complete')).not.toBeInTheDocument();
});

it('keeps results collapsed and controls reachable, while foregrounding the claimed scenario', async () => {
  const view = snapshot('RUNNING');
  view.campaign.syntheticJourney!.steps[0].name = 'Current bounded scenario';
  vi.mocked(api.syntheticCampaign).mockResolvedValue(view);
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Current bounded scenario' });
  expect(screen.getByText('All scenario results').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'Stop synthetic campaign' })).toBeEnabled();
  fireEvent.click(screen.getByText('All scenario results'));
  expect(screen.getByText('All scenario results').closest('details')).toHaveAttribute('open');
});

it('does not turn TCP counts or a simulated result into a received-load chart', async () => {
  const view = snapshot('COMPLETED');
  view.runs[0]!.verdict = {
    schema: 'v1',
    class: 'C',
    connections: { accepted: 42 },
    target: { avgBps: 999999999 },
  };
  vi.mocked(api.syntheticCampaign).mockResolvedValue(view);
  const mounted = render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Open final report' });
  expect(screen.getByLabelText('Campaign observations')).toHaveTextContent(
    '42connections accepted',
  );
  expect(screen.queryByText('Received load by scenario')).not.toBeInTheDocument();
  mounted.unmount();
  view.campaign.syntheticJourney!.steps[0].execution = 'SIMULATION';
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Open final report' });
  expect(screen.getByLabelText('Campaign observations')).toHaveTextContent(
    'No settled measurement yet',
  );
  expect(screen.queryByText('Received load by scenario')).not.toBeInTheDocument();
});

it('uses persisted finish time for elapsed duration and shows a held next scenario when paused', async () => {
  const view = snapshot('COMPLETED');
  Object.assign(view.campaign.syntheticJourney!, {
    startedAt: '2026-10-17T00:00:00Z',
    finishedAt: '2026-10-17T00:02:43Z',
  });
  vi.mocked(api.syntheticCampaign).mockResolvedValue(view);
  const mounted = render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByText('2m 43s');
  expect(screen.getByRole('heading', { name: 'Execution complete' })).toBeInTheDocument();
  mounted.unmount();
  const paused = snapshot('PAUSED');
  paused.runs[0] = null;
  vi.mocked(api.syntheticCampaign).mockResolvedValue(paused);
  render(
    <MemoryRouter>
      <SyntheticTheater id="campaign" />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Next scenario on hold' });
  expect(screen.getByRole('button', { name: 'Resume synthetic campaign' })).toBeEnabled();
});
