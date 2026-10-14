import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { FleetCampaignLive } from './fleet-campaign-live.js';
afterEach(() => vi.restoreAllMocks());
it('shows only the focused campaign count without agent details', async () => {
  const read = vi.spyOn(api, 'fleetCampaign').mockResolvedValue({
    campaignId: 'selected',
    mission: {
      id: 'mission',
      target: 'http://target.test/',
      createdAt: new Date().toISOString(),
      maxRps: 3,
      durationSec: 20,
      snapshot: {
        state: 'SETTLED',
        shards: [
          { agentId: 'one', state: 'STOPPED' },
          { agentId: 'two', state: 'LOST' },
        ],
      },
    },
  });
  render(<FleetCampaignLive campaignId="selected" />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('0 bots active of 2 assigned'),
  );
  expect(read).toHaveBeenCalledWith('selected');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('one')).not.toBeInTheDocument();
});

it('refreshes active bot counts from this campaign assignment rather than the whole fleet', async () => {
  const observation = (states: string[]) => ({
    campaignId: 'selected',
    mission: {
      id: 'mission',
      target: 'http://target.test/',
      createdAt: new Date().toISOString(),
      maxRps: 2,
      durationSec: 20,
      snapshot: {
        state: 'RUNNING',
        shards: states.map((state, i) => ({ agentId: `bot-${i}`, state })),
      },
    },
  });
  vi.spyOn(api, 'fleetCampaign')
    .mockResolvedValueOnce(observation(['RUNNING', 'PENDING']))
    .mockResolvedValue(observation(['SUCCEEDED', 'STOPPED']));
  render(<FleetCampaignLive campaignId="selected" expectedCount={3} />);
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('1 bots active of 2 assigned'),
  );
  expect(screen.queryByLabelText('Assigned bots')).not.toBeInTheDocument();
  await waitFor(
    () => expect(screen.getByRole('status')).toHaveTextContent('0 bots active of 2 assigned'),
    { timeout: 2500 },
  );
});

it('keeps missing observations unknown instead of reporting zero active bots', async () => {
  vi.spyOn(api, 'fleetCampaign').mockRejectedValue(new Error('Offline'));
  render(<FleetCampaignLive campaignId="selected" expectedCount={1} />);
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Live count unavailable'),
  );
  expect(screen.getByRole('status')).toHaveTextContent('— bots active of 1 selected');
  expect(screen.queryByLabelText('Assigned bots')).not.toBeInTheDocument();
});
