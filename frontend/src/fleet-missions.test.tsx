import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FleetMissions } from './fleet-missions.js';
import { api, type FleetDevice } from './api.js';
afterEach(() => vi.restoreAllMocks());
const status = {
  enabled: true,
  target: 'http://lab-target:8080/',
  caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
  missions: [],
};
const device = {
  id: 'sensor-one',
  name: 'Sensor one',
  privateIp: '10.1.1.1',
  connection: 'online',
  agentVersion: 'fleet-mission-agent/v1',
} as FleetDevice;
it('requires operator confirmation and submits the selected existing device', async () => {
  vi.spyOn(api, 'fleetMissions').mockResolvedValue(status);
  const launch = vi.spyOn(api, 'launchFleetMission').mockResolvedValue({});
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<FleetMissions devices={[device]} editable />);
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Launch lab mission' }));
  expect(launch).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Launch lab mission' }));
  await waitFor(() =>
    expect(launch).toHaveBeenCalledWith({
      deviceIds: ['sensor-one'],
      maxRps: 3,
      concurrency: 1,
      durationSec: 20,
      confirmed: true,
    }),
  );
});
it('offers no launch to read-only users and differentiates missing outcome from acknowledged results', async () => {
  vi.spyOn(api, 'fleetMissions').mockResolvedValue({
    ...status,
    missions: [
      {
        id: 'mission-one',
        createdAt: new Date().toISOString(),
        maxRps: 3,
        durationSec: 20,
        snapshot: { state: 'SETTLED', shards: [{ agentId: 'sensor-one', state: 'LOST' }] },
      },
    ],
  });
  render(<FleetMissions devices={[device]} editable={false} />);
  expect(await screen.findByText('LOST')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Launch lab mission' })).not.toBeInTheDocument();
  expect(screen.getByText(/final outcome is unknown/)).toBeInTheDocument();
});
