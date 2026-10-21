import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsClient = fakeApi.drsClient as unknown as ReturnType<typeof vi.fn>;

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => makeApp(),
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { ClientPage } = await import('./client-page.js');

describe('client dossier', () => {
  it('shows the signed scope, the contacts and the campaigns', async () => {
    drsClient.mockResolvedValue({
      client: {
        id: 'c1',
        name: 'Acme Payments',
        contacts: [{ name: 'S. Martin', email: 's.martin@acme.eu', role: 'CISO' }],
        scope: {
          reference: 'SOW-2026-10',
          signedAt: '2026-10-02T10:00:00.000Z',
          targets: ['https://pay.acme.eu'],
          maxRps: 8000,
        },
        createdAt: '2026-10-02T10:00:00.000Z',
        updatedAt: '2026-10-02T10:00:00.000Z',
      },
      campaigns: [
        {
          id: 'c1',
          name: 'DRS L1 — pay.acme.eu',
          target: 'https://pay.acme.eu',
          drsDocument: {
            currentRevision: 1,
            revisions: [
              {
                number: 1,
                id: 'r1',
                state: 'FINAL_REPORT',
                plan: { mode: 'measured' },
                proofs: [{ id: 'p1', hash: 'h', provenance: 'x' }],
                trace: [],
                finalizedAt: '2026-10-19T20:00:00.000Z',
                reference: {
                  standardVersion: '3.00.00',
                  engineVersion: 'e',
                  catalogueHash: 'h',
                  interpretationProfile: 'i',
                },
              },
            ],
          },
        },
      ],
    });
    renderWithRouter(<ClientPage />, { route: '/clients/c1', path: '/clients/:id' });
    expect(await screen.findByText('Acme Payments')).toBeTruthy();
    expect(screen.getByText('SOW-2026-10')).toBeTruthy();
    expect(screen.getByText(/8,000 rps/)).toBeTruthy();
    expect(screen.getByText('s.martin@acme.eu')).toBeTruthy();
    expect(screen.getByText('DRS L1 — pay.acme.eu')).toBeTruthy();
  });
});
