import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi, afterEach } from 'vitest';
import { ClientPrototype } from './client-prototype.js';
import { api, type DrsCampaignView } from './api.js';
import { makeApp } from './test-utils.js';
import type { ClientWorkspace } from './client-workspace-types.js';
const client: ClientWorkspace = {
  id: 'bank-cz',
  revision: 0,
  hash: null,
  status: 'authorized',
  authorization: 'client-authorized-target-scope-separate',
  measuredScore: null,
  profile: {
    name: 'bank.cz',
    environment: 'unspecified',
    reference: 'bank.cz',
    owner: '',
    scope: 'Login journey',
    notes: '',
  },
};
const app = makeApp({ role: 'admin', authRequired: true, userMode: 'single' });
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
afterEach(() => vi.restoreAllMocks());
const revision = {
  id: 'revision',
  number: 1,
  state: 'DRAFT',
  plan: { mode: 'engine-validation', maxLevel: 5 },
  proofs: [],
  trace: [],
  reference: {
    standardVersion: '3.00.00',
    engineVersion: 'engine',
    catalogueHash: 'hash',
    interpretationProfile: 'profile',
  },
};
function renderPrototype() {
  return render(
    <MemoryRouter initialEntries={['/clients/bank-cz?prototype=campaign']}>
      <ClientPrototype client={client} />
    </MemoryRouter>,
  );
}
it('resumes a saved prototype, freezes it, confirms simulation and generates the client report', async () => {
  let current = { ...revision };
  vi.spyOn(api, 'drsCampaign').mockImplementation(async () => ({
    clientWorkspace: client,
    document: { currentRevision: 1, revisions: [current] },
    defaultPlan: revision.plan,
  }));
  const action = vi.spyOn(api, 'drsAction').mockImplementation(async (_id, name) => {
    if (name === 'freeze') current = { ...current, planHash: 'hash' } as typeof current;
    if (name === 'simulate')
      current = {
        ...current,
        proofs: [{ id: 'proof', hash: 'hash', provenance: 'simulation' }],
      } as typeof current;
    if (name === 'finalize')
      current = { ...current, finalizedAt: new Date().toISOString() } as typeof current;
    return {};
  });
  vi.spyOn(api, 'drsReport').mockResolvedValue({
    clientWorkspace: client,
    revision: 1,
    reference: revision.reference,
    assessment: {
      label: 'Simulation score',
      status: 'COMPLETE',
      score: 5,
      terminalLevel: 5,
      terminalOutcome: 'PASS',
      levels: [],
      reservations: [],
    },
  });
  renderPrototype();
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze prototype plan' }));
  const run = await screen.findByRole('button', { name: 'Run simulated assessment' });
  expect(run).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(run);
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      'campaign',
      'simulate',
      expect.objectContaining({ confirmed: true, fixture: 'healthy' }),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Generate final report' }));
  await screen.findByRole('button', { name: 'Download prototype report' });
  expect(screen.getByText(/measured client score: not evaluated/)).toBeInTheDocument();
  expect(api.drsReport).toHaveBeenCalledWith('campaign', 1);
});
it('rejects a saved campaign from another client instead of showing its evidence', async () => {
  vi.spyOn(api, 'drsCampaign').mockResolvedValue({
    clientWorkspace: { ...client, id: 'test-vps' },
    document: { currentRevision: 1, revisions: [revision] },
    defaultPlan: revision.plan,
  } satisfies DrsCampaignView);
  renderPrototype();
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Freeze prototype plan' })).not.toBeInTheDocument();
});

it('creates a level-5 prototype for the selected client and retains creation failures', async () => {
  const create = vi
    .spyOn(api, 'drsValidation')
    .mockRejectedValueOnce(new Error('Storage unavailable'));
  render(
    <MemoryRouter>
      <ClientPrototype client={client} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New prototype campaign' }));
  await screen.findByText('Storage unavailable');
  expect(create).toHaveBeenCalledWith(5, 'bank-cz');
  create.mockResolvedValueOnce({
    id: 'new',
    name: 'bank.cz prototype',
    target: 'simulation://fixture',
    probeUrl: 'simulation://fixture',
    vector: 'http-get',
    maxRps: 3,
    concurrency: 3,
    maxDurationSec: 20,
    status: 'PENDING_APPROVAL',
    createdBy: 'fixture',
  });
  vi.spyOn(api, 'drsCampaign').mockResolvedValue({
    clientWorkspace: client,
    document: { currentRevision: 1, revisions: [revision] },
    defaultPlan: revision.plan,
  });
  fireEvent.click(screen.getByRole('button', { name: 'New prototype campaign' }));
  await screen.findByRole('button', { name: 'Freeze prototype plan' });
});
it('shows an action failure without presenting a final report', async () => {
  vi.spyOn(api, 'drsCampaign').mockResolvedValue({
    clientWorkspace: client,
    document: { currentRevision: 1, revisions: [revision] },
    defaultPlan: revision.plan,
  });
  vi.spyOn(api, 'drsAction').mockRejectedValue(
    new Error('Revision changed; reload before mutating'),
  );
  renderPrototype();
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze prototype plan' }));
  await screen.findByText('Revision changed; reload before mutating');
  expect(
    screen.queryByRole('button', { name: 'Download prototype report' }),
  ).not.toBeInTheDocument();
});
