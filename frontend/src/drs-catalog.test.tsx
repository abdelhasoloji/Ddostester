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
afterEach(() => vi.restoreAllMocks());
it('offers only supported DRS Fleet configuration and disables unsupported profiles without local fallback', async () => {
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
  expect(
    screen.queryByRole('button', { name: 'Unsupported by current agents' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show full catalogue' }));
  expect(screen.getByRole('button', { name: 'Unsupported by current agents' })).toBeDisabled();
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
