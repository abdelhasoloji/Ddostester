import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type Campaign, type DrsCampaignView, type FleetOverview } from './api.js';
import { DrsLaunchReview } from './drs-launch-review.js';
import { makeApp } from './test-utils.js';
let app = makeApp();
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
const campaign: Campaign = {
  id: 'internal',
  name: 'Internal test',
  target: 'http://lab-target:8080/',
  probeUrl: 'http://lab-target:8080/health',
  agent: 'fleet',
  fleetDeviceIds: ['one'],
  drsMode: 'synthetic-lab',
  vector: 'http-get',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  status: 'PENDING_APPROVAL',
  createdBy: 'abdelha@wedos',
  createdAt: '',
};
const view = (): DrsCampaignView => ({
  defaultPlan: {},
  document: {
    currentRevision: 1,
    revisions: [
      {
        id: 'rev',
        number: 1,
        state: 'PLAN_FROZEN',
        planHash: 'frozen',
        plan: {
          mode: 'synthetic-lab',
          budgets: { maxRps: 3, concurrency: 3, maxAgents: 1, maxDurationSec: 20 },
        },
        proofs: [],
        trace: [],
        reference: {
          standardVersion: '3.00.00',
          engineVersion: 'engine',
          catalogueHash: 'catalogue',
          interpretationProfile: 'strict',
        },
      },
    ],
  },
});
const fleet = (): FleetOverview => ({
  enabled: true,
  observedAt: '',
  group: '*',
  origins: ['http://lab-target:8080'],
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  missions: [],
  devices: [
    {
      id: 'one',
      agentId: 'one',
      name: 'one',
      group: 'lab',
      profile: 'sensor',
      privateIp: '10.1.0.1',
      notes: '',
      createdAt: '',
      updatedAt: '',
      connection: 'online',
      missionCapable: true,
      supportedMethods: ['GET'],
    },
  ],
});
beforeEach(() => {
  app = makeApp({
    role: 'admin',
    authRequired: true,
    userMode: 'single',
    allowed: ['lab-target'],
    drsWorkflow: true,
  });
  vi.spyOn(api, 'drsCampaign').mockResolvedValue(view());
  vi.spyOn(api, 'fleetOverview').mockResolvedValue(fleet());
  vi.spyOn(api, 'fleetDevice').mockResolvedValue({
    ...fleet().devices[0],
    agentVersion: 'fleet-mission-agent/v1',
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function show(c = campaign) {
  render(
    <MemoryRouter>
      <DrsLaunchReview campaign={c} />
    </MemoryRouter>,
  );
}
it('checks configuration without dispatching and requires a separate explicit launch', async () => {
  show();
  const start = screen.getByRole('button', { name: 'Start baseline and test' });
  expect(start).toBeDisabled();
  await waitFor(() => expect(start).toBeEnabled());
  expect(screen.getByRole('status')).toHaveTextContent('baseline health still to be qualified');
  expect(app.execute).not.toHaveBeenCalled();
  fireEvent.click(start);
  fireEvent.click(start);
  expect(app.execute).toHaveBeenCalledTimes(1);
  expect(app.execute).toHaveBeenCalledWith(campaign);
});
it('offers plan review when the revision is not frozen', async () => {
  const draft = view();
  delete draft.document!.revisions[0].planHash;
  vi.mocked(api.drsCampaign).mockResolvedValue(draft);
  show();
  await screen.findByText('Save and freeze an active test plan.');
  expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeDisabled();
  expect(screen.getByRole('link', { name: 'Review test plan' })).toHaveAttribute(
    'href',
    '/campaigns?tab=evidence&campaign=internal',
  );
});
it.each(['offline', 'budget', 'origin', 'measured', 'archived'] as const)(
  'blocks %s without substituting agents or weakening the plan',
  async (failure) => {
    const inventory = fleet(),
      plan = view();
    if (failure === 'offline')
      vi.mocked(api.fleetDevice).mockResolvedValue({
        ...inventory.devices[0],
        connection: 'offline',
        agentVersion: 'fleet-mission-agent/v1',
      });
    if (failure === 'budget') inventory.caps.maxRps = 2;
    if (failure === 'origin') inventory.origins = [];
    if (failure === 'measured') plan.document!.revisions[0].plan.mode = 'measured';
    if (failure === 'archived') plan.archived = true;
    vi.mocked(api.drsCampaign).mockResolvedValue(plan);
    vi.mocked(api.fleetOverview).mockResolvedValue(inventory);
    show();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeDisabled();
    expect(app.execute).not.toHaveBeenCalled();
  },
);
it('discards successful checks when a refresh fails', async () => {
  show();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeEnabled(),
  );
  vi.mocked(api.fleetOverview).mockRejectedValueOnce(Error('Inventory unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh checks' }));
  await screen.findByText('Checks unavailable: Inventory unavailable');
  expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeDisabled();
});
it('expires checks and requires a fresh observation before confirmation', async () => {
  show();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeEnabled(),
  );
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16000);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Checks expired');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh checks' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeEnabled(),
  );
});

it('checks selected identities directly rather than substituting the first inventory page', async () => {
  vi.mocked(api.fleetOverview).mockResolvedValue({ ...fleet(), devices: [] });
  show();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeEnabled(),
  );
  expect(api.fleetDevice).toHaveBeenCalledWith('one');
});

it('retains team approval and CISO gates before a physical launch', async () => {
  app = makeApp({ ...app, approvalPolicy: 'dual_control', requireCisoApproval: true });
  show();
  await screen.findByText('Approval is required before execution.');
  expect(screen.getByText('CISO sign-off is required before execution.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start baseline and test' })).toBeDisabled();
});
