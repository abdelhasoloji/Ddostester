import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { api, type FleetDevice } from './api.js';
import { makeApp } from './test-utils.js';
import { FleetPage } from './fleet-page.js';
import { FleetEnrollmentControls } from './fleet-enrollment.js';
import { FleetSitesPanel } from './fleet-sites.js';
let app = makeApp();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => app,
}));
vi.mock('./pages.js', () => ({ PageHead: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('./fleet-operations.js', () => ({ FleetOperations: () => null }));
vi.mock('./fleet-missions.js', () => ({ FleetMissions: () => null }));
vi.mock('./fleet-live.js', () => ({ FleetLivePanel: () => null }));
const device: FleetDevice = {
  id: 'one',
  agentId: 'sensor-01',
  name: 'Sensor One',
  siteId: 'site-a',
  group: 'Lab',
  profile: 'sensor',
  privateIp: '10.1.1.1',
  notes: 'fixture',
  createdAt: '',
  updatedAt: '',
  connection: 'online',
  agentVersion: 'fleet-mission-agent/v1',
  lastSeenAt: new Date().toISOString(),
};
let devices: FleetDevice[];
let total: number;
beforeEach(() => {
  app = makeApp({ role: 'admin', authRequired: true, userMode: 'single', drsWorkflow: true });
  devices = [device];
  total = 1;
  vi.spyOn(api, 'fleetDevices').mockImplementation(async () => ({ devices, total }));
  vi.spyOn(api, 'fleetSites').mockResolvedValue({
    sites: [{ id: 'site-a', devices: 1, online: 1 }],
    devices: 1,
    limits: { maxDevices: 5000, maxSites: 100, pageSize: 100 },
  });
});
afterEach(() => vi.restoreAllMocks());
function page() {
  return render(
    <MemoryRouter>
      <FleetPage />
    </MemoryRouter>,
  );
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it('registers, edits and explicitly removes inventory without launching an agent', async () => {
  const save = vi.spyOn(api, 'saveFleetDevice').mockImplementation(async (body) => {
    devices = [{ ...device, ...body }];
    return devices[0];
  });
  const remove = vi.spyOn(api, 'removeFleetDevice').mockImplementation(async () => {
    devices = [];
  });
  page();
  await screen.findByRole('button', { name: 'Edit Sensor One' });
  fireEvent.click(screen.getByRole('button', { name: 'Register device' }));
  fill('Device name', 'New Sensor');
  fill('Agent ID', 'sensor-new');
  fill('Site ID (stable)', 'site-b');
  fill('Device group', 'Site B');
  fill('Private IPv4 address', '10.2.1.1');
  fill('Device profile', 'camera');
  fill('Notes', 'new fixture');
  fireEvent.click(screen.getByRole('button', { name: 'Save device' }));
  await screen.findByText('Device registered.');
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: 'New Sensor',
      siteId: 'site-b',
      profile: 'camera',
      privateIp: '10.2.1.1',
    }),
    undefined,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit New Sensor' }));
  fill('Device name', 'Renamed Sensor');
  fireEvent.click(screen.getByRole('button', { name: 'Save device' }));
  await screen.findByText('Device updated.');
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Renamed Sensor' }), 'one');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Renamed Sensor' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Confirm removal' })).getByRole('button', {
      name: 'Cancel',
    }),
  );
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Renamed Sensor' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await screen.findByText('Device removed from inventory.');
  expect(remove).toHaveBeenCalledWith('one');
});
it('keeps rejected edits visible and exposes unknown connection state after refresh failure', async () => {
  vi.spyOn(api, 'saveFleetDevice').mockRejectedValue(Error('Duplicate site address'));
  page();
  await screen.findByRole('button', { name: 'Edit Sensor One' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Sensor One' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save device' }));
  await screen.findByText('Duplicate site address');
  expect(screen.getByLabelText('Device name')).toHaveValue('Sensor One');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  vi.mocked(api.fleetDevices).mockRejectedValueOnce(Error('Collector offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await screen.findByText(/Fleet refresh unavailable/);
  expect(screen.getByText('unknown')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await waitFor(() =>
    expect(screen.queryByText(/Fleet refresh unavailable/)).not.toBeInTheDocument(),
  );
  expect(screen.getByText('online')).toBeInTheDocument();
});
it('preserves the removal dialog on failure and enforces read-only inventory', async () => {
  const remove = vi.spyOn(api, 'removeFleetDevice').mockRejectedValue(Error('Inventory locked'));
  const view = page();
  await screen.findByRole('button', { name: 'Remove Sensor One' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Sensor One' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await screen.findByText('Inventory locked');
  expect(screen.getByRole('region', { name: 'Confirm removal' })).toBeInTheDocument();
  expect(remove).toHaveBeenCalledOnce();
  view.unmount();
  app = makeApp({ role: 'viewer', authRequired: true, userMode: 'single', drsWorkflow: true });
  page();
  await screen.findByText('Read only');
  expect(screen.queryByRole('button', { name: 'Register device' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit Sensor One' })).not.toBeInTheDocument();
});
it('sends site, search and page filters to the server, resetting the page on filter changes', async () => {
  total = 250;
  page();
  await screen.findByRole('button', { name: 'Edit Sensor One' });
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await waitFor(() =>
    expect(api.fleetDevices).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
  );
  fill('Site', 'site-a');
  await waitFor(() =>
    expect(api.fleetDevices).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, siteId: 'site-a' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
  fill('Search devices', 'missing');
  await screen.findByText('No devices match your filters.');
  expect(api.fleetDevices).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 1, search: 'missing' }),
  );
});
it('reports unavailable inventory and site observations instead of showing a healthy empty fleet', async () => {
  vi.mocked(api.fleetDevices).mockRejectedValue(Error('Read unavailable'));
  vi.mocked(api.fleetSites).mockRejectedValue(Error('Sites unavailable'));
  page();
  await screen.findByText(/Inventory unavailable/);
  expect(screen.getByText(/Site observation unavailable/)).toBeInTheDocument();
});
it('requires explicit rotation and revocation, and retains errors without claiming success', async () => {
  const enroll = vi.spyOn(api, 'enrollFleetDevice').mockResolvedValue({
    schema: 'ddostester.fleet.enrollment/v1',
    deviceId: device.id,
    agentId: device.agentId,
    privateIp: device.privateIp,
    token: 'fixture-only',
    expiresAt: '2030-01-01',
  });
  const revoke = vi
    .spyOn(api, 'revokeFleetDevice')
    .mockRejectedValueOnce(Error('Revoke rejected'))
    .mockResolvedValue(device);
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(
    <FleetEnrollmentControls
      device={{ ...device, enrollmentExpiresAt: '2030-01-01' }}
      refresh={refresh}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Enroll Sensor One' }));
  expect(enroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enroll Sensor One' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rotation' }));
  await screen.findByText(/Enrollment ready/);
  expect(enroll).toHaveBeenCalledWith('one');
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Close enrollment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Sensor One' }));
  expect(revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await screen.findByText('Revoke rejected');
  expect(screen.getByRole('button', { name: 'Confirm revocation' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});
it('downloads enrollment only after a successful response and preserves its per-device identity', async () => {
  vi.spyOn(api, 'enrollFleetDevice')
    .mockRejectedValueOnce(Error('Enrollment rejected'))
    .mockResolvedValue({
      schema: 'ddostester.fleet.enrollment/v1',
      deviceId: device.id,
      agentId: device.agentId,
      privateIp: device.privateIp,
      token: 'fixture-only',
      expiresAt: '2030-01-01',
    });
  const create = vi.fn().mockReturnValue('blob:fixture');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = render(<FleetEnrollmentControls device={device} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enroll Sensor One' }));
  await screen.findByText('Enrollment rejected');
  expect(screen.queryByRole('button', { name: 'Download enrollment' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Enroll Sensor One' }));
  await screen.findByText(/Enrollment ready/);
  fireEvent.click(screen.getByRole('button', { name: 'Download enrollment' }));
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('fleet-sensor-01.json');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
  view.unmount();
  vi.unstubAllGlobals();
});
it('renders registered site totals as inventory, without declaring deployment capacity', async () => {
  render(<FleetSitesPanel />);
  await screen.findByText('site-a');
  expect(
    screen.getByText('Registered sites — not Kubernetes deployment status'),
  ).toBeInTheDocument();
  expect(screen.getByText(/not a validated simultaneous execution/)).toBeInTheDocument();
});
