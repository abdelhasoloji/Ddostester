import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsGuardrails = fakeApi.drsGuardrails as unknown as ReturnType<typeof vi.fn>;
const audit = fakeApi.audit as unknown as ReturnType<typeof vi.fn>;

vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { GuardrailsPage } = await import('./guardrails-page.js');

describe('guardrails', () => {
  it('states the applied bounds and that nothing is certified', async () => {
    audit.mockResolvedValue([
      {
        id: 'a1',
        at: '2026-10-21T10:00:00.000Z',
        actor: 'dev',
        action: 'drs.verdict',
        campaignId: 'c1',
        detail: 'PARTIAL',
      },
    ]);
    drsGuardrails.mockResolvedValue({
      hardCaps: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
      serviceCeiling: { maxRps: 10000, maxConcurrency: 400, maxDurationSec: 900, maxAgents: 3 },
      baselineFloorSec: 300,
      allowlist: ['http://127.0.0.1:8099'],
      witnesses: { entry: false, origin: false, privateAllowed: false },
      killSwitch: true,
      certification: false,
    });
    renderWithRouter(<GuardrailsPage />);
    expect(await screen.findByText(/2,000 rps/)).toBeTruthy();
    expect(screen.getByText(/10,000 rps/)).toBeTruthy();
    expect(screen.getByText('never claimed')).toBeTruthy();
    expect(screen.getByText(/aborts a running exposure/)).toBeTruthy();
    expect(screen.getByText(/Audit trail/)).toBeTruthy();
    expect(screen.getByText('drs.verdict')).toBeTruthy();
  });
});
