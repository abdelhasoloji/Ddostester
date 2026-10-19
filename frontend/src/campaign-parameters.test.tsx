import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign } from './api.js';
const fakeApi = makeApi();
let app = makeApp();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => app,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));
const { CampaignParameters } = await import('./campaign-parameters.js');
const campaign = {
  id: 'editable',
  name: 'Next step',
  status: 'APPROVED',
  maxRps: 5,
  concurrency: 2,
  maxDurationSec: 3,
} as Campaign;
beforeEach(() => {
  app = makeApp();
  fakeApi.campaignParameters = vi.fn().mockResolvedValue({
    campaign,
    revision: 'original',
    limits: { maxRps: 20, maxConcurrency: 5, maxDurationSec: 15 },
    builtin: { rps: 150, concurrency: 300 },
  });
  fakeApi.updateCampaignParameters = vi
    .fn()
    .mockResolvedValue({ ...campaign, status: 'PENDING_APPROVAL' });
});
it('shows server bounds and saves edited parameters with the original revision', async () => {
  renderWithRouter(<CampaignParameters campaign={campaign} />);
  fireEvent.click(screen.getByRole('button', { name: 'Parameters' }));
  const rate = await screen.findByRole('spinbutton', { name: /Rate/ });
  expect(rate).toHaveAttribute('max', '20');
  expect(screen.getByRole('spinbutton', { name: /Concurrency/ })).toHaveAttribute('max', '5');
  expect(screen.getByRole('spinbutton', { name: /Duration/ })).toHaveAttribute('max', '15');
  fireEvent.change(rate, { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save parameters' }));
  await waitFor(() =>
    expect(fakeApi.updateCampaignParameters).toHaveBeenCalledWith(
      'editable',
      expect.objectContaining({ revision: 'original', maxRps: 4 }),
    ),
  );
});
it('keeps historical campaigns immutable and honors the sequence edit lock', () => {
  const { rerender } = renderWithRouter(
    <CampaignParameters campaign={{ ...campaign, runId: 'retained' }} />,
  );
  expect(screen.queryByRole('button', { name: 'Parameters' })).not.toBeInTheDocument();
  rerender(<CampaignParameters campaign={campaign} disabled />);
  expect(screen.getByRole('button', { name: 'Parameters' })).toBeDisabled();
});
