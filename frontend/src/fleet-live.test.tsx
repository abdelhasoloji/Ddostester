import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { FleetLivePanel } from './fleet-live.js';
afterEach(() => vi.restoreAllMocks());
it('shows recorded state and expired lease without claiming termination', async () => {
  vi.spyOn(api, 'fleetStatus').mockResolvedValue({
    configured: true,
    available: true,
    observedAt: '2026-10-13T15:00:00Z',
    run: { runId: 'run', state: 'RUNNING', controlLeaseExpired: true },
    agents: [
      {
        agentId: 'one',
        state: 'RUNNING',
        attemptId: 'attempt',
        leaseUntil: 1,
        leaseExpired: true,
        budget: { maxRps: 5, concurrency: 2, durationSec: 30 },
        progress: null,
        progressAt: null,
      },
    ],
  });
  render(<FleetLivePanel />);
  expect(await screen.findByText('expired')).toBeInTheDocument();
  expect(screen.getByText(/does not prove process termination/)).toBeInTheDocument();
  expect(screen.getByText('5 RPS · 2 concurrent')).toBeInTheDocument();
  expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
});
it('reports failed reads as unavailable rather than keeping a healthy snapshot', async () => {
  vi.spyOn(api, 'fleetStatus').mockRejectedValue(new Error('session expired'));
  render(<FleetLivePanel />);
  expect(await screen.findByRole('status')).toHaveTextContent('Fleet observation unavailable');
});
