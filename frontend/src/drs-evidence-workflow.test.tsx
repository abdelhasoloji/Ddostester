import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { api, type DrsRevisionView, type DrsReportView } from './api.js';
import { makeApp } from './test-utils.js';
import { DrsAssessmentWorkspace } from './drs-assessment-workspace.js';
let app = makeApp();
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => app,
}));
let revision: DrsRevisionView;
const campaign = {
  id: 'evidence-fixture',
  name: 'Evidence fixture',
  target: 'http://lab-target/',
  probeUrl: 'http://lab-target/',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  status: 'PENDING_APPROVAL',
  createdBy: 'fixture',
  vector: 'http-get',
  createdAt: '',
};
const reference = {
  standardVersion: '3.00.00',
  engineVersion: 'shieldtester-drs/1',
  catalogueHash: 'hash',
  interpretationProfile: 'strict-conservative/1',
};
const report: DrsReportView = {
  revision: 2,
  reference,
  assessment: {
    label: 'Experimental result',
    status: 'INDETERMINATE',
    score: null,
    terminalLevel: null,
    terminalOutcome: 'NOT_EVALUATED',
    levels: [
      {
        level: 1,
        total: 2,
        passed: 0,
        failed: 0,
        inconclusive: 2,
        excluded: 0,
        outcome: 'UNKNOWN',
      },
    ],
    reservations: ['Independent origin evidence missing'],
  },
};
beforeEach(() => {
  app = makeApp({ campaigns: [campaign], role: 'admin', authRequired: true, userMode: 'single' });
  revision = {
    number: 2,
    id: 'revision-two',
    state: 'PLAN_FROZEN',
    planHash: 'frozen',
    plan: { mode: 'synthetic-lab', maxLevel: 1, baselineMinSec: 300, exposureSec: 20 },
    reference,
    proofs: [],
    trace: [{ state: 'PLAN_FROZEN', at: '', detail: 'Original evidence retained' }],
  };
  vi.spyOn(api, 'drsReference').mockResolvedValue({
    manifest: { version: '3.00.00', catalogue_sha256: 'hash', vector_count: 131 },
    ambiguities: [],
  });
  vi.spyOn(api, 'drsCampaign').mockImplementation(async () => ({
    document: {
      currentRevision: 2,
      revisions: [{ ...revision, number: 1, id: 'old', finalizedAt: 'previous' }, revision],
    },
    defaultPlan: revision.plan,
  }));
  vi.spyOn(api, 'drsReport').mockResolvedValue(report);
  vi.spyOn(api, 'drsAction').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());
function page() {
  return render(
    <MemoryRouter initialEntries={app.campaigns.length ? ['/?campaign=evidence-fixture'] : ['/']}>
      <DrsAssessmentWorkspace />
    </MemoryRouter>,
  );
}
async function ready() {
  await screen.findByLabelText('DRS verdict');
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it('archives collector evidence and exactly one attachment with the displayed revision identity', async () => {
  page();
  await ready();
  const attach = screen.getByRole('button', { name: 'Attach existing observation' });
  expect(attach).toBeDisabled();
  change('Existing campaign run ID', 'run-one');
  change('Existing isolated lab verdict ID', 'bench-one');
  expect(attach).toBeDisabled();
  change('Existing isolated lab verdict ID', '');
  fireEvent.click(attach);
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenCalledWith('evidence-fixture', 'attachments', {
      revisionId: 'revision-two',
      runId: 'run-one',
      benchRunId: undefined,
    }),
  );
  change('Existing campaign run ID', '');
  change('Existing isolated lab verdict ID', 'bench-one');
  fireEvent.click(attach);
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenLastCalledWith('evidence-fixture', 'attachments', {
      revisionId: 'revision-two',
      runId: undefined,
      benchRunId: 'bench-one',
    }),
  );
  change('Evidence JSON', '{"provenance":"collector-import"}');
  fireEvent.click(screen.getByRole('button', { name: 'Archive evidence' }));
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenLastCalledWith('evidence-fixture', 'evidence', {
      revisionId: 'revision-two',
      evidence: { provenance: 'collector-import' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check capacity' }));
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenLastCalledWith('evidence-fixture', 'capacity', {
      revisionId: 'revision-two',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Finalize report' }));
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenLastCalledWith('evidence-fixture', 'finalize', {
      revisionId: 'revision-two',
    }),
  );
  expect(screen.getByLabelText('DRS verdict')).toHaveTextContent('No usable score');
  expect(screen.getByText('Independent origin evidence missing')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Revision 1 · PLAN_FROZEN' })).toHaveAttribute(
    'href',
    expect.stringContaining('revision=1'),
  );
});
it('requires new revision for parameter changes and rejects malformed JSON locally', async () => {
  revision.state = 'DRAFT';
  revision.planHash = undefined;
  page();
  await screen.findByLabelText('Assessment plan JSON');
  expect(screen.getByRole('button', { name: 'Freeze plan' })).toBeEnabled();
  change('Campaign mode', 'measured');
  change('Maximum reference level', '3');
  change('Baseline seconds', '450');
  change('Exposure seconds', '30');
  expect(screen.getByRole('button', { name: 'Freeze plan' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Create new revision' }));
  await waitFor(() =>
    expect(api.drsAction).toHaveBeenCalledWith('evidence-fixture', 'revisions', {
      plan: { mode: 'measured', maxLevel: 3, baselineMinSec: 450, exposureSec: 30 },
    }),
  );
  vi.mocked(api.drsAction).mockClear();
  change('Assessment plan JSON', '{');
  change('Campaign mode', 'engine-validation');
  await screen.findByText('Correct plan JSON before changing mode');
  change('Baseline seconds', '500');
  await screen.findByText('Correct plan JSON before editing parameters');
  fireEvent.click(screen.getByRole('button', { name: 'Create new revision' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(api.drsAction).not.toHaveBeenCalled();
});
it('keeps stale-revision rejection visible and does not convert it to successful evidence', async () => {
  vi.mocked(api.drsAction).mockRejectedValue(Error('Stale revision; reload before writing'));
  page();
  await ready();
  change('Evidence JSON', '{"attempt":"fixture"}');
  fireEvent.click(screen.getByRole('button', { name: 'Archive evidence' }));
  await screen.findByText('Stale revision; reload before writing');
  expect(screen.getByLabelText('DRS verdict')).toHaveTextContent('INDETERMINATE');
  change('Evidence JSON', '{');
  vi.mocked(api.drsAction).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Archive evidence' }));
  await waitFor(() => expect(screen.getByRole('alert')).not.toHaveTextContent('Stale revision'));
  expect(api.drsAction).not.toHaveBeenCalled();
});
it('disables evidence writes for a viewer and for finalized reports', async () => {
  app = makeApp({ campaigns: [campaign], role: 'viewer', authRequired: true, userMode: 'single' });
  const view = page();
  await ready();
  change('Evidence JSON', '{}');
  expect(screen.getByRole('button', { name: 'Archive evidence' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Create new revision' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Finalize report' })).toBeDisabled();
  expect(api.drsAction).not.toHaveBeenCalled();
  view.unmount();
  app = makeApp({ campaigns: [campaign], role: 'admin', authRequired: true });
  revision.finalizedAt = 'finished';
  page();
  await ready();
  expect(screen.getByRole('button', { name: 'Check capacity' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Archive evidence' })).not.toBeInTheDocument();
});
it('creates a standalone no-traffic validation and displays failure to create it', async () => {
  app = makeApp({ campaigns: [], role: 'admin', authRequired: true });
  const create = vi
    .spyOn(api, 'drsValidation')
    .mockRejectedValueOnce(Error('Cannot save validation'))
    .mockResolvedValue(campaign as Awaited<ReturnType<typeof api.drsValidation>>);
  page();
  expect(screen.getByText(/Validate the engine without a target/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New engine validation · no traffic' }));
  await screen.findByText('Cannot save validation');
  fireEvent.click(screen.getByRole('button', { name: 'New engine validation · no traffic' }));
  await ready();
  expect(create).toHaveBeenCalledTimes(2);
  expect(app.refresh).toHaveBeenCalledOnce();
  expect(api.drsCampaign).toHaveBeenCalledWith('evidence-fixture');
});
it('reports failed JSON download and successful reproducible export without altering a verdict', async () => {
  page();
  await ready();
  vi.mocked(api.drsReport).mockRejectedValueOnce(Error('Archive unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Download reproducible JSON' }));
  await screen.findByText('Archive unavailable');
  const create = vi.fn().mockReturnValue('blob:drs');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Download reproducible JSON' }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:drs'));
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(
    'drs-evidence-fixture-revision-2.json',
  );
  expect(screen.getByLabelText('DRS verdict')).toHaveTextContent('INDETERMINATE');
  vi.unstubAllGlobals();
});
