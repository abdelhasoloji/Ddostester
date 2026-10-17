import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { makeApp } from './test-utils.js';
import { api } from './api.js';
import { DrsCatalogPanel } from './drs-catalog.js';
const app = makeApp({
  agents: [
    ...makeApp().agents,
    {
      id: 'fleet',
      name: 'iot-fleet',
      available: true,
      multiPhase: false,
      flowCapable: false,
      description: 'Fleet',
    },
  ],
});
vi.mock('./context.js', async (original) => ({
  ...(await original<typeof import('./context.js')>()),
  useApp: () => app,
}));
vi.mock('./bench-card.js', () => ({
  BenchCard: ({ initialScenario }: { initialScenario: string }) => (
    <div>Prepared bench: {initialScenario}</div>
  ),
}));
afterEach(() => vi.restoreAllMocks());
it('shows the full DRS reference by default and only permits supported Fleet configuration', async () => {
  vi.spyOn(api, 'drsCatalog').mockResolvedValue({
    version: 'v1',
    reference: 'DRS v3',
    provenance: 'Repository references',
    scope: 'Bounded measurement',
    inventoryCaps: { maxDevices: 5000, maxSites: 100, pageSize: 100 },
    executionCaps: { maxAgents: 3, maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
    profiles: [
      {
        id: 'cra-l7-get-flood',
        name: 'GET DRS3',
        level: 3,
        summary: 'GET',
        supported: true,
        status: 'bounded-get',
        reason: 'Bounded',
      },
      {
        id: 'post',
        name: 'POST DRS4',
        level: 4,
        summary: 'POST',
        supported: false,
        status: 'unsupported',
        reason: 'Missing adapter',
      },
    ],
  });
  render(<DrsCatalogPanel target="http://target.test/" deviceIds={['agent-1']} />);
  await waitFor(() => expect(screen.getByText('GET DRS3')).toBeInTheDocument());
  expect(screen.getByRole('checkbox', { name: 'Show full catalogue' })).toBeChecked();
  expect(screen.getByLabelText('Execution source')).toHaveValue('synthetic');
  fireEvent.change(screen.getByLabelText('Execution source'), { target: { value: 'fleet' } });
  expect(screen.getByRole('button', { name: 'Unsupported by current agents' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show full catalogue' }));
  expect(screen.queryByText('POST DRS4')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show full catalogue' }));
  expect(screen.getByText('POST DRS4')).toBeInTheDocument();
  expect(screen.getByText('Reference and capacity details').closest('details')).not.toHaveAttribute(
    'open',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Configure Fleet campaign' }));
  expect(app.queueReplay).toHaveBeenCalledWith(
    expect.objectContaining({
      drsProfileId: 'cra-l7-get-flood',
      agent: 'fleet',
      target: 'http://target.test/',
      fleetDeviceIds: ['agent-1'],
      maxRps: 3,
    }),
  );
  expect(screen.getByText(/registry capacity/)).toBeInTheDocument();
});

it('prepares only an explicit registered synthetic shape without dispatching or replaying the client target', async () => {
  const dispatch = vi.spyOn(api, 'createBenchRun');
  vi.spyOn(api, 'drsCatalog').mockResolvedValue({
    version: '3.00.00',
    reference: 'DRS',
    provenance: 'Pinned',
    scope: 'Reference',
    inventoryCaps: { maxDevices: 5000, maxSites: 100, pageSize: 100 },
    executionCaps: { maxAgents: 3, maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
    profiles: [
      {
        id: 'ntp',
        name: 'NTP Reflection Flood',
        level: 3,
        summary: 'Source line',
        supported: false,
        status: 'reference-only',
        reason: 'Reference',
        laboratory: {
          scenarioId: 'udp_ntp_reflection',
          mode: 'synthetic-lab',
          qualification: 'partial-shape',
          representedDimensions: ['NTP-like shape'],
          missingDimensions: ['Protocol semantics'],
          scoreEligible: false,
        },
      },
      {
        id: 'rst',
        name: 'TCP RST Flood',
        level: 3,
        summary: 'Source line',
        supported: false,
        status: 'reference-only',
        reason: 'Reference',
      },
    ],
  });
  render(<DrsCatalogPanel target="https://client.invalid/" />);
  await screen.findByText('NTP Reflection Flood');
  expect(screen.getByText('TCP RST Flood')).toBeInTheDocument();
  expect(
    screen.getByText('No matching synthetic shape. Remains not evaluated.'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare synthetic scenario' }));
  expect(screen.getByText('Prepared bench: udp_ntp_reflection')).toBeInTheDocument();
  expect(screen.getByText(/not the client URL/)).toBeInTheDocument();
  expect(dispatch).not.toHaveBeenCalled();
});
