import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TheaterTelemetry } from './theater-telemetry.js';
import { api, type Campaign } from './api.js';
vi.mock('./PromChart.js', () => ({ PromChart: () => <div>Scoped observed chart</div> }));
const campaign = {
  id: 'campaign',
  status: 'RUNNING',
  drsDocument: {
    currentRevision: 1,
    revisions: [
      { id: 'revision', number: 1, plan: { mode: 'synthetic-lab' }, proofs: [], trace: [] },
    ],
  },
} as unknown as Campaign;
afterEach(() => vi.restoreAllMocks());
it('scopes all Grafana-equivalent panels to the exact campaign and revision', async () => {
  vi.spyOn(api, 'metricsRange').mockResolvedValue({
    source: 'ok',
    name: 'fixture',
    title: 'Observed',
    unit: 'short',
    series: [{ label: 'observed', points: [[1, 2]] }],
  });
  render(<TheaterTelemetry campaign={campaign} />);
  await screen.findAllByText('Scoped observed chart');
  expect(api.metricsRange).toHaveBeenCalledTimes(3);
  expect(api.metricsRange).toHaveBeenCalledWith(
    'drs_agents',
    expect.objectContaining({ campaignId: 'campaign', revisionId: 'revision' }),
  );
  expect(screen.getByText(/synthetic-lab · Provisional/)).toBeInTheDocument();
});
it('keeps absent or failed data unknown instead of displaying zero or success', async () => {
  vi.spyOn(api, 'metricsRange').mockResolvedValue({
    source: 'unavailable',
    name: 'fixture',
    title: 'Unknown',
    unit: 'short',
    series: [],
  });
  render(<TheaterTelemetry campaign={campaign} />);
  await waitFor(() =>
    expect(screen.getAllByText('No qualified observation available')).toHaveLength(3),
  );
  expect(screen.queryByText('Scoped observed chart')).not.toBeInTheDocument();
});
it('clears old observations when changing campaign scope and exposes request errors', async () => {
  vi.spyOn(api, 'metricsRange').mockResolvedValue({
    source: 'ok',
    name: 'fixture',
    title: 'Observed',
    unit: 'short',
    series: [{ label: 'observed', points: [[1, 2]] }],
  });
  const { rerender } = render(<TheaterTelemetry campaign={campaign} />);
  await screen.findAllByText('Scoped observed chart');
  vi.mocked(api.metricsRange).mockRejectedValue(Error('Disconnected'));
  rerender(<TheaterTelemetry campaign={{ ...campaign, id: 'other' }} />);
  await screen.findByText('Some observations are unavailable');
  expect(screen.queryByText('Scoped observed chart')).not.toBeInTheDocument();
});
