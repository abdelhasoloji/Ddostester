import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsClients = fakeApi.drsClients as unknown as ReturnType<typeof vi.fn>;
const drsCapacity = fakeApi.drsCapacity as unknown as ReturnType<typeof vi.fn>;
const createDrsPlan = fakeApi.createDrsPlan as unknown as ReturnType<typeof vi.fn>;

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => makeApp(),
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { WizardPage } = await import('./wizard-page.js');

beforeEach(() => {
  drsClients.mockResolvedValue({
    clients: [
      {
        id: 'c1',
        client: 'Acme Payments',
        registered: true,
        contacts: [],
        scope: {
          reference: 'SOW-1',
          signedAt: '2026-10-02T10:00:00.000Z',
          targets: ['https://pay.acme.eu'],
          maxRps: 8000,
        },
        assessments: 0,
        finalized: 0,
        targets: [],
        lastAt: null,
        lastState: '—',
      },
    ],
  });
  drsCapacity.mockResolvedValue({
    ceiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    scope: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900, targets: [] },
    envelope: {
      maxRps: 2000,
      maxConcurrency: 500,
      maxDurationSec: 900,
      agents: 1,
      limitedBy: { rps: 'scope', concurrency: 'scope' },
      warnings: [],
    },
    calibrations: [],
    reachability: [],
  });
  createDrsPlan.mockReset();
});

describe('campaign wizard', () => {
  it('picks the client target, chooses the synthetic mode and freezes the plan', async () => {
    createDrsPlan.mockResolvedValue({ id: 'n1', name: 'DRS L1 — pay.acme.eu' });
    renderWithRouter(<WizardPage />);

    // Step 1: the target comes from the signed scope.
    await waitFor(() => expect(screen.getByDisplayValue('https://pay.acme.eu')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2: synthetic amplifier.
    fireEvent.click(screen.getByRole('button', { name: /synthetic amplifier/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: rationale is mandatory.
    fireEvent.change(screen.getByPlaceholderText(/why this level/i), {
      target: { value: 'validate the measurement chain before a real run' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 4: attest and freeze.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /freeze the plan/i }));

    await waitFor(() =>
      expect(createDrsPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'c1',
          target: 'https://pay.acme.eu',
          mode: 'synthetic-lab',
          authorized: true,
          rationale: 'validate the measurement chain before a real run',
        }),
      ),
    );
  });

  it('will not freeze without the authorisation attestation', async () => {
    renderWithRouter(<WizardPage />);
    await screen.findByDisplayValue('https://pay.acme.eu');
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.change(screen.getByPlaceholderText(/why this level/i), {
      target: { value: 'a reason long enough to pass validation' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    const freeze = screen.getByRole('button', { name: /freeze the plan/i });
    expect(freeze).toBeDisabled();
  });
});
