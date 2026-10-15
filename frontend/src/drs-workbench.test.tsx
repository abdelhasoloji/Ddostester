import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DrsWorkbenchHome, ClientWorkspacePage, PilotInfrastructurePage } from './drs-workbench.js';
import { api } from './api.js';
import { makeApp } from './test-utils.js';
import type { ClientProfile } from './client-workspace-types.js';
const initialClients: { id: string; profile: ClientProfile }[] = [
  {
    id: 'bank-cz',
    profile: {
      name: 'bank.cz',
      environment: 'unspecified',
      reference: 'bank.cz',
      owner: '',
      scope: '',
      notes: '',
    },
  },
  {
    id: 'enisa-preprod',
    profile: {
      name: 'ENISA preproduction',
      environment: 'preproduction',
      reference: '',
      owner: '',
      scope: '',
      notes: '',
    },
  },
  {
    id: 'test-vps',
    profile: {
      name: 'Test VPS',
      environment: 'lab',
      reference: '46.28.109.92',
      owner: '',
      scope: '',
      notes: '',
    },
  },
];
import type { ClientWorkspaceList } from './client-workspace-types.js';
let app = makeApp();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => app,
}));
vi.mock('./pages.js', () => ({
  PageHead: ({ title, sub }: { title: string; sub: string }) => (
    <>
      <h1>{title}</h1>
      <p>{sub}</p>
    </>
  ),
}));
vi.mock('./infrastructure-workspace.js', () => ({
  InfrastructureWorkspacePanel: () => <div>Detailed inventory</div>,
}));
const fixture = (): ClientWorkspaceList => ({
  targetLevel: 5,
  pilot: { sites: 2, independentProbe: 1, capacityQualified: false },
  clients: initialClients.map((c) => ({
    id: c.id,
    revision: 0,
    hash: null,
    profile: { ...c.profile },
    status: 'authorized',
    authorization: 'client-authorized-target-scope-separate',
    measuredScore: null,
  })),
});
beforeEach(() => {
  app = makeApp({ role: 'admin', authRequired: true, userMode: 'single', drsWorkflow: true });
  vi.spyOn(api, 'clientWorkspaces').mockResolvedValue(fixture());
});
afterEach(() => vi.restoreAllMocks());
function home() {
  return render(
    <MemoryRouter>
      <DrsWorkbenchHome />
    </MemoryRouter>,
  );
}
function client() {
  return render(
    <MemoryRouter initialEntries={['/clients/bank-cz']}>
      <Routes>
        <Route path="/clients/:id" element={<ClientWorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}
it('shows only the three authorized clients and the pilot hypothesis, without a measured level or launch control', async () => {
  home();
  await screen.findByRole('heading', { name: 'bank.cz' });
  expect(screen.getAllByText('Authorized client')).toHaveLength(3);
  expect(screen.getByRole('heading', { name: 'ENISA preproduction' })).toBeInTheDocument();
  expect(screen.getByText('46.28.109.92')).toBeInTheDocument();
  expect(screen.getByText('2 PoPs')).toBeInTheDocument();
  expect(screen.getAllByText('Not evaluated')).toHaveLength(3);
  expect(
    screen.queryByRole('button', { name: /launch|execute|add client/i }),
  ).not.toBeInTheDocument();
  expect(api.clientWorkspaces).toHaveBeenCalledTimes(1);
});
it('persists client scope and retains rejected edits without changing client identity', async () => {
  const save = vi
    .spyOn(api, 'saveClientWorkspace')
    .mockImplementation(async (id, revision, profile) => ({
      ...fixture().clients[0],
      id,
      revision: revision + 1,
      profile,
    }));
  client();
  await screen.findByRole('button', { name: 'Edit client scope' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit client scope' }));
  expect(screen.getByLabelText('Client name')).toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Services and functional scope'), {
    target: { value: 'Login journey' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save client scope' }));
  await screen.findByText('Client scope saved.');
  expect(save).toHaveBeenCalledWith(
    'bank-cz',
    0,
    expect.objectContaining({ name: 'bank.cz', scope: 'Login journey' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit client scope' }));
  save.mockRejectedValueOnce(Error('Client changed; reload before saving'));
  fireEvent.click(screen.getByRole('button', { name: 'Save client scope' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Services and functional scope')).toHaveValue('Login journey');
});
it('keeps client evidence unbound and hides editing from readers', async () => {
  app = makeApp({ role: 'viewer', authRequired: true, userMode: 'single', drsWorkflow: true });
  client();
  await screen.findByRole('heading', { name: 'bank.cz' });
  expect(screen.queryByRole('button', { name: 'Edit client scope' })).not.toBeInTheDocument();
  expect(screen.getByText(/No measured assessment evidence is bound/)).toBeInTheDocument();
});
it('does not replace a failed portfolio read with fabricated clients', async () => {
  vi.mocked(api.clientWorkspaces).mockRejectedValueOnce(Error('Offline'));
  home();
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'bank.cz' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh clients' }));
  await screen.findByRole('heading', { name: 'bank.cz' });
});
it('keeps unobserved PoP and probe states unknown after a collection failure', async () => {
  vi.spyOn(api, 'infrastructure').mockRejectedValueOnce(Error('Unavailable'));
  render(
    <MemoryRouter>
      <PilotInfrastructurePage />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  expect(screen.getByText('Site to assign')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'External probe' })).toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
});
