import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi, afterEach } from 'vitest';
import { ClientAssessmentArchive } from './client-assessment-archive.js';
import { api } from './api.js';
import type { Campaign } from './api.js';
const profile = {
  name: 'bank.cz',
  environment: 'unspecified' as const,
  reference: 'bank.cz',
  owner: '',
  scope: '',
  notes: '',
};
const campaign: Campaign = {
  id: 'bank',
  name: 'Prototype',
  drsMode: 'engine-validation',
  clientWorkspace: { id: 'bank-cz', revision: 1, hash: 'hash', profile },
  createdAt: '2026-10-15T12:00:00Z',
  createdBy: 'fixture',
  status: 'PENDING_APPROVAL',
  target: 'simulation://fixture',
  probeUrl: 'simulation://fixture',
  vector: 'http-get',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
};
afterEach(() => vi.restoreAllMocks());
it('filters client-bound prototypes and preserves archived history without mixing physical or unbound runs', async () => {
  vi.spyOn(api, 'listCampaigns').mockResolvedValue([
    campaign,
    {
      ...campaign,
      id: 'vps',
      archived: true,
      clientWorkspace: {
        ...campaign.clientWorkspace!,
        id: 'test-vps',
        profile: { ...profile, name: 'Test VPS' },
      },
    },
    { ...campaign, id: 'physical', drsMode: 'measured' },
    { ...campaign, id: 'unbound', clientWorkspace: undefined },
  ]);
  render(
    <MemoryRouter>
      <ClientAssessmentArchive />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Resume campaign' });
  expect(screen.getAllByRole('row')).toHaveLength(3);
  expect(screen.getByRole('link', { name: 'Resume campaign' })).toHaveAttribute(
    'href',
    '/clients/bank-cz?prototype=bank',
  );
  expect(screen.getByRole('link', { name: 'Open campaign' })).toHaveAttribute(
    'href',
    '/clients/test-vps?prototype=vps',
  );
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'test-vps' } });
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.queryByRole('link', { name: 'Resume campaign' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'enisa-preprod' } });
  expect(screen.getByText('No client assessments yet.')).toBeInTheDocument();
});

it('reports archive read failures instead of showing an empty history', async () => {
  vi.spyOn(api, 'listCampaigns').mockRejectedValue(new Error('Storage unavailable'));
  render(
    <MemoryRouter>
      <ClientAssessmentArchive />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  expect(screen.queryByText('No client assessments yet.')).not.toBeInTheDocument();
});
