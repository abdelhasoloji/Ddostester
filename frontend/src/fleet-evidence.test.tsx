import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { FleetEvidencePanel } from './fleet-evidence.js';
import type { CampaignRun } from './api.js';
it('shows incomplete fleet evidence and unknown resources instead of healthy zeroes', () => {
  const run = {
    generator: {
      fleet: {
        measurementComplete: false,
        shards: [{ agentId: 'one', state: 'LOST', attemptId: 'attempt', leaseUntil: 0 }],
      },
    },
  } as CampaignRun;
  render(<FleetEvidencePanel run={run} />);
  expect(screen.getByRole('region', { name: 'Fleet evidence' })).toBeInTheDocument();
  expect(screen.getByText(/Incomplete measurement/)).toBeInTheDocument();
  expect(screen.getByText('LOST')).toBeInTheDocument();
  expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(5);
  expect(screen.queryByText('0.0 ms')).not.toBeInTheDocument();
});
