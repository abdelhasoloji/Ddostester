import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { api } from './api.js';
import { makeApp } from './test-utils.js';
import { DrsAssessmentWorkspace } from './drs-assessment-workspace.js';
const app = makeApp({
  campaigns: [
    {
      id: 'fixture',
      name: 'Bounded lab fixture',
      target: 'http://lab-target/',
      probeUrl: 'http://lab-target/',
      maxRps: 3,
      concurrency: 3,
      maxDurationSec: 20,
      status: 'PENDING_APPROVAL',
      createdBy: 'fixture',
      vector: 'http-get',
      createdAt: new Date().toISOString(),
    },
  ],
});
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
afterEach(() => vi.restoreAllMocks());
it('freezes a new simulated revision and requires explicit confirmation before engine validation', async () => {
  const plan = { mode: 'engine-validation', maxLevel: 1 };
  const rev = {
    number: 1,
    id: 'revision',
    state: 'DRAFT',
    plan,
    proofs: [],
    trace: [],
    reference: {
      standardVersion: '3.00.00',
      engineVersion: 'shieldtester-drs/1',
      catalogueHash: 'hash',
      interpretationProfile: 'strict-conservative/1',
    },
  };
  vi.spyOn(api, 'drsReference').mockResolvedValue({
    manifest: { version: '3.00.00', catalogue_sha256: 'hash', vector_count: 131 },
    ambiguities: [],
  });
  vi.spyOn(api, 'drsCampaign')
    .mockResolvedValueOnce({ document: null, defaultPlan: plan })
    .mockResolvedValueOnce({
      document: { currentRevision: 1, revisions: [rev] },
      defaultPlan: plan,
    })
    .mockResolvedValue({
      document: {
        currentRevision: 1,
        revisions: [{ ...rev, state: 'PLAN_FROZEN', planHash: 'frozen' }],
      },
      defaultPlan: plan,
    });
  const action = vi.spyOn(api, 'drsAction').mockResolvedValue({});
  vi.spyOn(api, 'drsReport').mockResolvedValue({
    revision: 1,
    reference: rev.reference,
    assessment: {
      label: 'Simulation score — no resilience measurement',
      status: 'COMPLETE',
      score: 1,
      terminalLevel: 1,
      terminalOutcome: 'PASS',
      levels: [],
      reservations: ['Not a certification'],
    },
  });
  render(
    <MemoryRouter>
      <DrsAssessmentWorkspace />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Campaign mode')).toHaveValue('engine-validation'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save test plan' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('fixture', 'revisions', { plan }));
  fireEvent.click(screen.getByRole('button', { name: 'Freeze plan' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run engine validation' })).toBeDisabled(),
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Run engine validation' }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith('fixture', 'simulate', {
      revisionId: 'revision',
      fixture: 'healthy',
      confirmed: true,
    }),
  );
  expect(screen.getByLabelText('DRS verdict')).toHaveTextContent('Simulation score');
});
it('marks unavailable evidence as a missing plan rather than a resilience score', async () => {
  vi.spyOn(api, 'drsReference').mockResolvedValue({
    manifest: { version: '3.00.00', catalogue_sha256: 'hash', vector_count: 131 },
    ambiguities: [],
  });
  vi.spyOn(api, 'drsCampaign').mockRejectedValue(new Error('Independent evidence unavailable'));
  render(
    <MemoryRouter>
      <DrsAssessmentWorkspace />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Independent evidence unavailable'),
  );
  expect(screen.queryByLabelText('DRS verdict')).not.toBeInTheDocument();
});
