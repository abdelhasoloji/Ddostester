import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { api } from './api.js';
import { InfrastructureWorkspacePanel } from './infrastructure-workspace.js';
import { DrsBaselineDiagnostic, baselineDistribution } from './drs-baseline-diagnostic.js';
import type {
  InfrastructureWorkspace,
  InfrastructureHost,
  InfrastructureRecord,
} from './infrastructure-types.js';
const profile: InfrastructureHost = {
  siteId: 'site-a',
  name: 'Physical A',
  architecture: null,
  os: null,
  runtime: null,
  cores: null,
  memoryGiB: null,
  nicModel: null,
  linkGbps: null,
  managementInterface: null,
  dataInterface: null,
  managementAddress: null,
  publicAddresses: [],
  observedEgressAddresses: [],
  notes: '',
};
const host: InfrastructureRecord<InfrastructureHost> = {
  kind: 'host',
  id: 'host-a',
  revision: 1,
  schemaVersion: 1,
  at: '2026-10-15T00:00:00Z',
  actor: 'admin',
  previousHash: null,
  hash: 'a'.repeat(64),
  payload: profile,
};
const fixture = (): InfrastructureWorkspace => ({
  hosts: [host, { ...host, id: 'host-b' }, { ...host, id: 'host-c' }],
  evidence: [],
  qualification: {
    status: 'incomplete',
    hardwareQualified: false,
    executionAuthorized: false,
    scope: 'Operator evidence only',
    selectedHosts: [],
  },
  limits: { maxHosts: 100, maxEvidence: 512, maxRevisions: 64, maxEvidenceChars: 8192 },
  readiness: {
    standardVersion: '3.00.00',
    catalogueHash: 'b'.repeat(64),
    targetLevel: 5,
    scope: 'Product capability inventory',
    fullPhysicalVectorsQualified: 0,
    levels: [{ level: 1, total: 4, boundedHttp: 1, physicalQualified: 0 }],
    vectors: [],
  },
});
beforeEach(() => {
  vi.spyOn(api, 'infrastructure').mockResolvedValue(fixture());
});
afterEach(() => vi.restoreAllMocks());
async function open(editable = true) {
  render(<InfrastructureWorkspacePanel editable={editable} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open infrastructure workspace' }));
  await screen.findByText('Physical hosts');
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it('does no background request until opened and exposes unknown specifications', async () => {
  render(<InfrastructureWorkspacePanel editable />);
  expect(api.infrastructure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open infrastructure workspace' }));
  await screen.findByText('Physical hosts');
  expect(api.infrastructure).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText('Unknown / Unknown')).toHaveLength(6);
  expect(screen.getByText(/0 full physical vectors qualified/)).toBeInTheDocument();
});
it('saves declared host data while keeping unspecified quantities null and preserving comma-separated addresses', async () => {
  const save = vi
    .spyOn(api, 'saveInfrastructureHost')
    .mockResolvedValue({ ...host, id: 'new-host' });
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Add physical host' }));
  fill('Stable host ID', 'new-host');
  fill('Host name', 'New host');
  fill('Host site ID', 'site-b');
  fill('Host architecture', 'arm64');
  fill('Allocated public IPs (comma separated)', '192.0.2.1, 192.0.2.2');
  fireEvent.click(screen.getByRole('button', { name: 'Save host revision' }));
  await screen.findByText('Host revision saved.');
  expect(save).toHaveBeenCalledWith(
    'new-host',
    0,
    expect.objectContaining({
      architecture: 'arm64',
      cores: null,
      publicAddresses: ['192.0.2.1', '192.0.2.2'],
    }),
  );
});
it('retains a rejected concurrent edit and uses the server revision when saving', async () => {
  const save = vi
    .spyOn(api, 'saveInfrastructureHost')
    .mockRejectedValue(Error('Profile changed; reload before saving'));
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Edit host host-a' }));
  fill('Operating system', 'Linux');
  fireEvent.click(screen.getByRole('button', { name: 'Save host revision' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Operating system')).toHaveValue('Linux');
  expect(save).toHaveBeenCalledWith('host-a', 1, expect.objectContaining({ os: 'Linux' }));
});
it('supports exactly two selected pilot hosts without an execution control', async () => {
  await open();
  fireEvent.click(screen.getByLabelText('Select pilot host-a'));
  await waitFor(() => expect(api.infrastructure).toHaveBeenLastCalledWith(['host-a']));
  fireEvent.click(screen.getByLabelText('Select pilot host-b'));
  await waitFor(() => expect(api.infrastructure).toHaveBeenLastCalledWith(['host-a', 'host-b']));
  await waitFor(() => expect(screen.getByLabelText('Select pilot host-c')).toBeDisabled());
  expect(
    screen.queryByRole('button', { name: /launch|deploy|start campaign/i }),
  ).not.toBeInTheDocument();
});
it('records evidence against the exact host hash and leaves its outcome unknown by default', async () => {
  const add = vi.spyOn(api, 'addInfrastructureEvidence').mockResolvedValue({
    kind: 'evidence',
    id: 'receipt',
    revision: 1,
    schemaVersion: 1,
    at: '',
    actor: 'admin',
    previousHash: null,
    hash: 'c'.repeat(64),
    payload: {
      hostId: host.id,
      profileHash: host.hash,
      gate: 'architecture',
      outcome: 'unknown',
      observedAt: '2026-10-15T00:00:00Z',
      content: 'Receipt',
    },
  });
  await open();
  fill('Evidence host', 'host-a');
  fill('Observed at (local time)', '2026-10-15T12:00');
  fill('Sanitized evidence', 'Receipt');
  fireEvent.click(screen.getByRole('button', { name: 'Save attestation' }));
  await screen.findByText(/Attestation retained/);
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({
      hostId: 'host-a',
      profileHash: host.hash,
      outcome: 'unknown',
      content: 'Receipt',
    }),
  );
});
it('allows readers to inspect history but hides all writes', async () => {
  const history = vi.spyOn(api, 'infrastructureHistory').mockResolvedValue({ revisions: [host] });
  await open(false);
  expect(screen.queryByRole('button', { name: 'Add physical host' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit host host-a' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('form', { name: 'Record infrastructure evidence' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History host-a' }));
  await screen.findByText('Retained host revisions');
  expect(history).toHaveBeenCalledWith('host', 'host-a');
});
it('removes stale readiness when a refresh fails and permits an explicit retry', async () => {
  await open();
  vi.mocked(api.infrastructure).mockRejectedValueOnce(Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh infrastructure' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Physical hosts')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh infrastructure' }));
  await screen.findByText('Physical hosts');
});
it('displays the retained baseline distribution without removing an outlier or claiming clock measurements', () => {
  const samples = [1, 1, 1, 1000];
  expect(baselineDistribution(samples)).toEqual({
    valid: 4,
    invalid: 0,
    min: 1,
    p50: 1,
    p95: 1000,
    max: 1000,
  });
  expect(samples).toEqual([1, 1, 1, 1000]);
  render(
    <DrsBaselineDiagnostic
      diagnostic={{
        reason: 'unstable',
        elapsedSec: 600,
        observedDurationSec: 590,
        samples: 4,
        samplesMs: samples,
        availabilityPct: 100,
        meanMs: 250.75,
        coefficientOfVariation: 1.7,
        tolerance: 0.1,
        minimumSec: 300,
      }}
    />,
  );
  const section = screen.getByRole('region', { name: 'Baseline refusal diagnostic' });
  expect(within(section).getByText('Baseline refused · unstable')).toBeInTheDocument();
  expect(within(section).getByText('Not recorded in this diagnostic')).toBeInTheDocument();
  expect(within(section).getByText('1.000 / 1.000 / 1000.000 / 1000.000 ms')).toBeInTheDocument();
  expect(within(section).getByText('[1,1,1,1000]')).toBeInTheDocument();
});
it('flags invalid and missing retained samples without showing them as a full distribution', () => {
  render(
    <DrsBaselineDiagnostic
      diagnostic={{
        reason: 'incomplete',
        elapsedSec: 1,
        observedDurationSec: 1,
        samples: 3,
        samplesMs: [-1, 2],
        availabilityPct: 100,
        meanMs: null,
        coefficientOfVariation: null,
        tolerance: 0.1,
        minimumSec: 300,
      }}
    />,
  );
  expect(screen.getAllByRole('alert')).toHaveLength(2);
});
