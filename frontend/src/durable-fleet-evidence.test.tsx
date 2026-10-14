import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
const read = vi.fn();
vi.mock('./api.js', () => ({ api: { fleetEvidenceForCampaign: read } }));
beforeEach(() => read.mockReset());
const { DurableFleetEvidencePanel } = await import('./durable-fleet-evidence.js');

it('reads recorded evidence explicitly and leaves absent results unknown', async () => {
  read.mockResolvedValue({
    sha256: 'hash',
    content: {
      schema: 'ddostester.fleet.persisted-evidence/v1',
      campaignId: 'c',
      runId: 'r',
      state: 'STOPPING',
      counterCoverage: { reportedAgents: 0, expectedAgents: 1 },
      shards: [{ agentId: 'one', state: 'LOST', result: null }],
      probe: null,
      wrs: null,
    },
  });
  render(<DurableFleetEvidencePanel campaignId="c" />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read recorded evidence' }));
  await screen.findByText(/0\/1 final agent reports/);
  expect(screen.getByText(/reported requests unknown/)).toBeInTheDocument();
  expect(screen.getByText(/WRS unavailable/)).toBeInTheDocument();
});

it('does not infer the original fleet size from surviving legacy rows', async () => {
  read.mockResolvedValue({
    content: {
      schema: 'ddostester.fleet.persisted-evidence/v1',
      campaignId: 'legacy',
      state: 'STOPPING',
      counterCoverage: { reportedAgents: 0, expectedAgents: null },
      shards: [],
    },
  });
  render(<DurableFleetEvidencePanel campaignId="legacy" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read recorded evidence' }));
  await screen.findByText(/0\/unknown final agent reports/);
});
