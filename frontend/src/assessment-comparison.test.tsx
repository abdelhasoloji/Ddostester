import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { AssessmentComparison } from './assessment-comparison.js';
import { comparableReports } from './assessment-comparison-model.js';
import { api, type Campaign, type DrsReportView } from './api.js';
const scope = {
  id: 'bank-cz',
  revision: 1,
  hash: 'scope-hash',
  profile: {
    name: 'bank.cz',
    environment: 'unspecified' as const,
    reference: 'bank.cz',
    owner: '',
    scope: 'Login',
    notes: '',
  },
};
const reference = {
  standardVersion: '3.00.00',
  catalogueHash: 'catalogue-hash',
  engineVersion: 'engine',
  interpretationProfile: 'profile',
};
function campaign(id: string): Campaign {
  return {
    id,
    name: 'Prototype',
    drsMode: 'engine-validation',
    clientWorkspace: structuredClone(scope),
    createdBy: 'fixture',
    createdAt: '2026-10-16T00:00:00Z',
    status: 'COMPLETED',
    target: 'simulation://fixture',
    probeUrl: 'simulation://fixture',
    vector: 'http-get',
    maxRps: 3,
    concurrency: 3,
    maxDurationSec: 20,
    drsDocument: {
      currentRevision: 1,
      revisions: [
        {
          number: 1,
          id: 'revision-' + id,
          state: 'FINAL_REPORT',
          plan: { mode: 'engine-validation' },
          planHash: 'plan-hash',
          finalizedAt: '2026-10-16T00:00:01Z',
          proofs: [],
          trace: [],
          reference,
        },
      ],
    },
  };
}
function report(id: string): DrsReportView {
  return {
    revision: 1,
    revisionId: 'revision-' + id,
    planHash: 'plan-hash',
    clientWorkspace: structuredClone(scope),
    reference: { ...reference },
    assessment: {
      label: 'Simulation',
      status: 'COMPLETE',
      score: 1,
      terminalLevel: 1,
      terminalOutcome: 'PASS',
      reservations: [],
      levels: [
        { level: 1, total: 2, passed: 2, failed: 0, inconclusive: 0, excluded: 0, outcome: 'PASS' },
      ],
    },
  };
}
afterEach(() => vi.restoreAllMocks());
it('keeps partial results indeterminate and missing levels unevaluated', () => {
  const a = report('a'),
    b = report('b');
  b.assessment.status = 'PARTIAL';
  b.assessment.score = null;
  b.assessment.levels = [];
  const result = comparableReports('bank-cz', [campaign('a'), campaign('b')], [a, b]);
  expect(result.delta).toBeNull();
  expect(result.levels[0].b).toBeUndefined();
  expect(result.levels[0].a?.outcome).toBe('PASS');
  b.assessment.status = 'COMPLETE';
  b.assessment.score = 1.5;
  expect(comparableReports('bank-cz', [campaign('a'), campaign('b')], [a, b]).delta).toBe(0.5);
});
it('rejects mixed client, scope, reference, plan, mode and stale revision pairs', () => {
  const cases = [
    (c: Campaign[], _r: DrsReportView[]) => {
      c[1].clientWorkspace!.id = 'test-vps';
    },
    (c: Campaign[], r: DrsReportView[]) => {
      c[1].clientWorkspace!.revision = 2;
      r[1].clientWorkspace!.revision = 2;
    },
    (_c: Campaign[], r: DrsReportView[]) => {
      r[1].revisionId = 'stale';
    },
    (_c: Campaign[], r: DrsReportView[]) => {
      r[1].clientWorkspace!.revision = 3;
    },
    (_c: Campaign[], r: DrsReportView[]) => {
      r[1].reference = { ...reference, engineVersion: 'different' };
    },
    (c: Campaign[], r: DrsReportView[]) => {
      const changed = { ...reference, interpretationProfile: 'other-profile' };
      c[1].drsDocument!.revisions[0].reference = changed;
      r[1].reference = changed;
    },
    (c: Campaign[], r: DrsReportView[]) => {
      c[1].drsDocument!.revisions[0].planHash = 'other-plan';
      r[1].planHash = 'other-plan';
    },
    (c: Campaign[]) => {
      c[1].drsMode = 'measured';
    },
    (c: Campaign[]) => {
      delete c[1].drsDocument!.revisions[0].finalizedAt;
    },
  ];
  for (const change of cases) {
    const cs: [Campaign, Campaign] = [campaign('a'), campaign('b')],
      rs: [DrsReportView, DrsReportView] = [report('a'), report('b')];
    change(cs, rs);
    expect(() => comparableReports('bank-cz', cs, rs)).toThrow();
  }
  expect(() =>
    comparableReports('bank-cz', [campaign('a'), campaign('a')], [report('a'), report('a')]),
  ).toThrow('different assessments');
});
it('loads two reports and shows a compact read-only comparison, including archived reports', async () => {
  const a = campaign('a'),
    b = campaign('b');
  b.archived = true;
  vi.spyOn(api, 'drsReport').mockImplementation(async (id) => report(id));
  render(<AssessmentComparison clientId="bank-cz" campaigns={[a, b]} />);
  fireEvent.click(screen.getByText('Compare assessments'));
  fireEvent.change(screen.getByLabelText('Assessment A'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Assessment B'), { target: { value: 'b' } });
  await screen.findByText('Score change: 0');
  expect(api.drsReport).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Simulation only')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Assessment B'), { target: { value: 'a' } });
  await screen.findByRole('alert');
  expect(
    screen.queryByRole('region', { name: 'Assessment comparison result' }),
  ).not.toBeInTheDocument();
  expect(api.drsReport).toHaveBeenCalledTimes(2);
});
it('does not substitute an empty successful comparison for a failed read', async () => {
  vi.spyOn(api, 'drsReport').mockRejectedValue(new Error('Report unavailable'));
  render(<AssessmentComparison clientId="bank-cz" campaigns={[campaign('a'), campaign('b')]} />);
  fireEvent.change(screen.getByLabelText('Assessment A'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Assessment B'), { target: { value: 'b' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Report unavailable');
  expect(screen.queryByText('Score change: 0')).not.toBeInTheDocument();
});
it('ignores late results after the selected pair changes', async () => {
  let resolve!: (r: DrsReportView) => void;
  const pending = new Promise<DrsReportView>((r) => {
    resolve = r;
  });
  vi.spyOn(api, 'drsReport').mockImplementation((id) =>
    id === 'a' ? pending : Promise.resolve(report(id)),
  );
  render(<AssessmentComparison clientId="bank-cz" campaigns={[campaign('a'), campaign('b')]} />);
  fireEvent.change(screen.getByLabelText('Assessment A'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('Assessment B'), { target: { value: 'b' } });
  await screen.findByRole('status');
  fireEvent.change(screen.getByLabelText('Assessment B'), { target: { value: '' } });
  resolve(report('a'));
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(
    screen.queryByRole('region', { name: 'Assessment comparison result' }),
  ).not.toBeInTheDocument();
});
