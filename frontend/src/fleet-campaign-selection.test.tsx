import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { api, type FleetDevice, type FleetOverview } from './api.js';
import { makeApp } from './test-utils.js';
import { NewCampaignForm } from './new-campaign-form.js';
let app = makeApp();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => app,
}));
function device(id: string): FleetDevice {
  return {
    id,
    name: id,
    agentId: id,
    siteId: 'site-a',
    privateIp: '10.1.1.' + (id === 'one' ? 1 : 2),
    group: 'VPS Lab',
    profile: 'sensor',
    notes: '',
    createdAt: '',
    updatedAt: '',
    connection: 'online',
    agentVersion: 'fleet-mission-agent/v1',
  };
}
const seed = {
  name: 'Fleet fixture',
  target: 'http://lab-target:8080/check',
  probeUrl: 'http://lab-target:8080/health',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  drsProfileId: 'drs-3.00.00-151002',
  agent: 'fleet',
  fleetDeviceIds: ['one'],
};
beforeEach(() => {
  app = makeApp({
    allowed: ['lab-target'],
    drsWorkflow: true,
    role: 'admin',
    identity: { email: 'abdelha@wedos', role: 'admin' },
    authRequired: true,
    userMode: 'single',
    agents: [
      {
        id: 'fleet',
        name: 'iot-fleet',
        available: true,
        multiPhase: false,
        flowCapable: false,
        description: 'Enrolled workers',
      },
      {
        id: 'builtin',
        name: 'builtin-http',
        available: true,
        multiPhase: true,
        flowCapable: true,
        description: 'Local HTTP',
      },
    ],
  });
  vi.spyOn(api, 'fleetOverview').mockResolvedValue({
    enabled: true,
    devices: [{ ...device('one'), missionCapable: true, supportedMethods: ['GET'] }],
    origins: ['http://lab-target:8080'],
    group: '*',
    observedAt: '',
    missions: [],
    caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  } as FleetOverview);
  vi.spyOn(api, 'fleetDevices').mockImplementation(async (opts) => ({
    devices: [device(opts?.page === 2 ? 'two' : 'one')],
    total: 200,
  }));
  vi.spyOn(api, 'fleetSites').mockResolvedValue({
    sites: [{ id: 'site-a', devices: 200, online: 2 }],
    devices: 200,
    limits: { maxDevices: 5000, maxSites: 100, pageSize: 100 },
  });
});
afterEach(() => vi.restoreAllMocks());
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function attest() {
  fireEvent.click(screen.getByLabelText(/I attest that I own/));
}
it('keeps exact agent selections across pages and submits a shared budget with the assessment mode', async () => {
  const done = vi.fn();
  render(<NewCampaignForm initial={seed} onDone={done} />);
  await screen.findByRole('checkbox', { name: 'Use one' });
  expect(screen.getByRole('checkbox', { name: 'Use one' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Next agents' }));
  await screen.findByRole('checkbox', { name: 'Use two' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Previous agents' }));
  await screen.findByRole('checkbox', { name: 'Use one' });
  expect(screen.getByRole('checkbox', { name: 'Use one' })).toBeChecked();
  attest();
  const submit = screen.getByRole('button', { name: 'Create campaign' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() =>
    expect(app.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        fleetDeviceIds: ['one', 'two'],
        agent: 'fleet',
        target: seed.target,
        maxRps: 3,
        concurrency: 3,
        maxDurationSec: 20,
        authorized: true,
        drsMode: 'synthetic-lab',
      }),
    ),
  );
  expect(done).toHaveBeenCalledOnce();
});
it('does not substitute agents or fall back locally when fleet inventory cannot be read', async () => {
  vi.mocked(api.fleetDevices).mockRejectedValue(Error('Site disconnected'));
  render(<NewCampaignForm initial={seed} />);
  await screen.findByText(/Inventory unavailable: Site disconnected/);
  attest();
  expect(screen.getByRole('button', { name: 'Create campaign' })).toBeDisabled();
  expect(app.createCampaign).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Generator')).toHaveValue('fleet');
});
it('requires origin admission and retains rejected campaign input for correction', async () => {
  vi.mocked(app.createCampaign).mockRejectedValueOnce(Error('Session expired'));
  render(<NewCampaignForm initial={{ ...seed, target: 'http://lab-target:8081/check' }} />);
  await screen.findByRole('checkbox', { name: 'Use one' });
  attest();
  expect(screen.getByRole('button', { name: 'Create campaign' })).toBeDisabled();
  change('Target (URL)', seed.target);
  const submit = screen.getByRole('button', { name: 'Create campaign' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() => expect(app.push).toHaveBeenCalledWith('error', 'Session expired'));
  expect(screen.getByLabelText('Name')).toHaveValue('Fleet fixture');
  change('Max RPS', '16');
  expect(submit).toBeDisabled();
  change('Max RPS', '3');
  change('Concurrency', '7');
  expect(submit).toBeDisabled();
  change('Concurrency', '3');
  change('Max duration (s)', '61');
  expect(submit).toBeDisabled();
});
it('clears incompatible local options when switching to Fleet while retaining the budget for review', async () => {
  app = makeApp({ ...app, drsWorkflow: false });
  render(
    <NewCampaignForm
      initial={{
        ...seed,
        agent: 'builtin',
        vector: 'http-post',
        body: 'local payload',
        maxRps: 100,
        concurrency: 20,
        maxDurationSec: 120,
        cacheBust: true,
      }}
    />,
  );
  change('Generator', 'fleet');
  await screen.findByRole('checkbox', { name: 'Use one' });
  expect(screen.getByLabelText('Vector')).toHaveValue('http-get');
  expect(screen.queryByText(/Fleet supports a single constant GET/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('Max RPS')).toHaveValue(100);
  expect(screen.getByText(/Generator changed/)).toBeInTheDocument();
  attest();
  expect(screen.getByRole('button', { name: 'Create campaign' })).toBeDisabled();
});

it('keeps the physical preparation short and respects reduced server limits', async () => {
  const inventory = await api.fleetOverview();
  vi.mocked(api.fleetOverview).mockResolvedValue({
    ...inventory,
    caps: { maxRps: 2, maxConcurrency: 6, maxDurationSec: 60 },
  });
  render(<NewCampaignForm initial={seed} />);
  await screen.findByRole('checkbox', { name: 'Use one' });
  expect(screen.queryByLabelText('Synthetic device journey')).not.toBeInTheDocument();
  expect(screen.getByText('Choose agents').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText(/Shared limits/).closest('details')).not.toHaveAttribute('open');
  attest();
  expect(screen.getByRole('button', { name: 'Create campaign' })).toBeDisabled();
  change('Max RPS', '2');
  expect(screen.getByRole('button', { name: 'Create campaign' })).toBeEnabled();
});
