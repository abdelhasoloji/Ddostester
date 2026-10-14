import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type FleetOverview } from './api.js';
import { FleetOperations } from './fleet-operations.js';
const overview: FleetOverview = {
  enabled: true,
  origins: ['http://target.test'],
  observedAt: new Date().toISOString(),
  group: 'VPS Lab',
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  missions: [],
  devices: [
    {
      id: 'one',
      agentId: 'one',
      name: 'Sensor',
      group: 'VPS Lab',
      profile: 'sensor',
      privateIp: '10.1.1.1',
      notes: '',
      createdAt: '',
      updatedAt: '',
      connection: 'online',
      missionCapable: true,
      supportedMethods: ['GET'],
    },
    {
      id: 'two',
      agentId: 'two',
      name: 'Offline',
      group: 'VPS Lab',
      profile: 'camera',
      privateIp: '10.1.1.2',
      notes: '',
      createdAt: '',
      updatedAt: '',
      connection: 'offline',
      missionCapable: true,
      supportedMethods: ['GET'],
    },
  ],
};
afterEach(() => vi.restoreAllMocks());
it('does not let an offline device launch and exposes actual GET capability', async () => {
  vi.spyOn(api, 'fleetOverview').mockResolvedValue(overview);
  render(
    <MemoryRouter>
      <FleetOperations editable />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Select Sensor for campaign' }),
    ).toBeInTheDocument(),
  );
  expect(screen.getByRole('checkbox', { name: 'Select Offline for campaign' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Create campaign with selected agents' }),
  ).toBeDisabled();
  expect(screen.getAllByText(/GET only/)).toHaveLength(2);
});
it('keeps read-only users out of selection and launching controls', async () => {
  vi.spyOn(api, 'fleetOverview').mockResolvedValue(overview);
  render(
    <MemoryRouter>
      <FleetOperations />
    </MemoryRouter>,
  );
  await screen.findByText('Sensor');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Create campaign with selected agents' }),
  ).not.toBeInTheDocument();
});
