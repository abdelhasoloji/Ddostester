import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CampaignManager } from './campaign-manager.js';
import { api, type Campaign, type DrsSequencePlan } from './api.js';
import { makeApp } from './test-utils.js';
let app: Omit<ReturnType<typeof makeApp>, 'campaigns'> & { campaigns: Campaign[] } = makeApp();
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
vi.mock('./new-campaign-form.js', () => ({
  NewCampaignForm: ({
    onCreate,
    onDone,
  }: {
    onCreate: (body: unknown) => Promise<unknown>;
    onDone: () => void;
  }) => (
    <button
      onClick={() =>
        void onCreate({
          name: 'Fixture campaign',
          target: 'http://lab-target:8080/',
          probeUrl: 'http://lab-target:8080/health',
          fleetDeviceIds: ['one'],
          maxRps: 3,
          concurrency: 3,
          maxDurationSec: 20,
          authorized: true,
        }).then(onDone)
      }
    >
      Save configured campaign
    </button>
  ),
}));
const plan = (targetLevel = 5, intervalSec = 30): DrsSequencePlan => ({
  schema: 'shieldtester.drs.sequence/v1',
  targetLevel,
  intervalSec,
  catalogueHash: 'reference',
  planHash: 'plan',
  executable: 1,
  blocked: 1,
  measuredLevel: null,
  rows: [
    {
      id: 'supported',
      name: 'HTTP scenario',
      level: 1,
      supported: true,
      reason: 'bounded',
      sourceVectorId: '151002',
      ambiguityCount: 0,
    },
    {
      id: 'unsupported',
      name: 'Network scenario',
      level: 2,
      supported: false,
      reason: 'Generator required',
      sourceVectorId: 'other',
      ambiguityCount: 0,
    },
  ],
});
function campaign(frozen = true): Campaign {
  return {
    id: 'step',
    suiteId: 'suite',
    suiteOrder: 0,
    suiteName: 'Fixture campaign',
    name: 'HTTP scenario',
    drsSequence: plan(),
    drsProfileId: 'supported',
    drsMode: 'synthetic-lab',
    agent: 'fleet',
    fleetDeviceIds: ['one'],
    target: 'http://lab-target:8080/',
    probeUrl: 'http://lab-target:8080/health',
    vector: 'http-get',
    maxRps: 3,
    concurrency: 3,
    maxDurationSec: 20,
    status: 'PENDING_APPROVAL',
    createdBy: 'abdelha@wedos',
    drsDocument: {
      currentRevision: 1,
      revisions: [
        {
          id: 'revision',
          number: 1,
          state: frozen ? 'PLAN_FROZEN' : 'DRAFT',
          plan: { mode: 'synthetic-lab' },
          planHash: frozen ? 'hash' : undefined,
          proofs: [],
          trace: [],
          reference: {
            standardVersion: '3',
            engineVersion: 'engine',
            catalogueHash: 'reference',
            interpretationProfile: 'strict',
          },
        },
      ],
    },
  };
}
beforeEach(() => {
  app = makeApp({
    drsWorkflow: true,
    role: 'admin',
    authRequired: true,
    userMode: 'single',
    identity: { email: 'abdelha@wedos', role: 'admin' },
  });
  vi.spyOn(api, 'savedDrsSequencePlan').mockResolvedValue(plan());
  vi.spyOn(api, 'drsSequencePlan').mockImplementation(async (l, i) => plan(l, i));
  vi.spyOn(api, 'suiteSequences').mockResolvedValue({ sequences: {} });
  vi.spyOn(api, 'runSuite').mockResolvedValue({ suiteId: 'suite', steps: 1, started: true });
  vi.spyOn(api, 'freezeDrsSequence').mockResolvedValue({});
  vi.spyOn(api, 'pauseSuite').mockResolvedValue({ suiteId: 'suite', paused: true });
  vi.spyOn(api, 'cancelSuite').mockResolvedValue({
    suiteId: 'suite',
    cancelled: true,
    killedCurrent: false,
  });
  vi.spyOn(api, 'archiveSuite').mockResolvedValue({
    suiteId: 'suite',
    archived: true,
    changed: 1,
    total: 1,
  });
});
afterEach(() => vi.restoreAllMocks());
function show(selected = false) {
  render(
    <MemoryRouter
      initialEntries={[selected ? '/campaigns?tab=manager&suite=suite' : '/campaigns?tab=manager']}
    >
      <CampaignManager />
    </MemoryRouter>,
  );
}
it('shows the complete reference chain and saves the chosen objective and interval', async () => {
  vi.spyOn(api, 'createDrsSequence').mockImplementation(async () => {
    app.campaigns = [campaign(false)];
    return { suiteId: 'suite', campaigns: app.campaigns, plan: plan(3, 45) };
  });
  show();
  await screen.findByText('2 reference scenarios');
  fireEvent.change(screen.getByLabelText('Target DRS score'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Interval between scenarios (s)'), {
    target: { value: '45' },
  });
  await waitFor(() => expect(api.drsSequencePlan).toHaveBeenLastCalledWith(3, 45));
  fireEvent.click(screen.getByText('Complete execution chain'));
  expect(screen.getByText('Network scenario', { exact: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Configure campaign' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save configured campaign' }));
  await waitFor(() =>
    expect(api.createDrsSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLevel: 3,
        intervalSec: 45,
        authorized: true,
        createdBy: 'abdelha@wedos',
      }),
    ),
  );
  await screen.findByRole('button', { name: 'Freeze campaign plans' });
  expect(api.runSuite).not.toHaveBeenCalled();
});
it('requires explicit confirmation and forwards the reviewed sequence hash', async () => {
  app.campaigns = [campaign()];
  show(true);
  const review = await screen.findByRole('button', { name: 'Review and launch campaign' });
  await waitFor(() => expect(review).toBeEnabled());
  fireEvent.click(review);
  const launch = screen.getByRole('button', { name: 'Launch campaign' });
  expect(launch).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(launch);
  await waitFor(() => expect(api.runSuite).toHaveBeenCalledWith('suite', true, 'plan'));
  expect(api.runSuite).toHaveBeenCalledTimes(1);
});
it('keeps pause and stop independent of scenario completion', async () => {
  app.campaigns = [campaign()];
  vi.mocked(api.suiteSequences).mockResolvedValue({
    sequences: { suite: { paused: false, started: 1, total: 1 } },
  });
  show(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause campaign' }));
  await waitFor(() => expect(api.pauseSuite).toHaveBeenCalledWith('suite'));
  fireEvent.click(screen.getByRole('button', { name: 'Stop campaign' }));
  await waitFor(() => expect(api.cancelSuite).toHaveBeenCalledWith('suite'));
});
it('keeps reader controls read-only and exposes the report', async () => {
  app = makeApp({
    drsWorkflow: true,
    authRequired: true,
    userMode: 'single',
    role: 'viewer',
    campaigns: [campaign()],
  });
  show(true);
  await screen.findByText('2 reference scenarios');
  expect(
    screen.queryByRole('button', { name: 'Review and launch campaign' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Campaign report' })).toHaveAttribute(
    'href',
    '/api/suites/suite/drs/report?format=html',
  );
});
it('does not turn unavailable live state into launch readiness', async () => {
  app.campaigns = [campaign()];
  vi.mocked(api.suiteSequences).mockRejectedValue(Error('Disconnected'));
  show(true);
  await screen.findByText('2 reference scenarios');
  expect(screen.getByRole('button', { name: 'Review and launch campaign' })).toBeDisabled();
});
it('duplicates into a new draft without mutating historical scope or interval', async () => {
  app.campaigns = [campaign()];
  show(true);
  await screen.findByText('2 reference scenarios');
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate campaign' }));
  expect(screen.getByLabelText('Interval between scenarios (s)')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Interval between scenarios (s)'), {
    target: { value: '60' },
  });
  await waitFor(() => expect(api.drsSequencePlan).toHaveBeenLastCalledWith(5, 60));
  expect(app.campaigns[0].drsSequence?.intervalSec).toBe(30);
  expect(api.runSuite).not.toHaveBeenCalled();
});

it('keeps stop available while a pause request is still pending', async () => {
  app.campaigns = [campaign()];
  vi.mocked(api.suiteSequences).mockResolvedValue({
    sequences: { suite: { paused: false, started: 1, total: 1 } },
  });
  let release!: (value: { suiteId: string; paused: boolean }) => void;
  vi.mocked(api.pauseSuite).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  show(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause campaign' }));
  const stop = screen.getByRole('button', { name: 'Stop campaign' });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  await waitFor(() => expect(api.cancelSuite).toHaveBeenCalledWith('suite'));
  release({ suiteId: 'suite', paused: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause campaign' })).toBeEnabled());
});
