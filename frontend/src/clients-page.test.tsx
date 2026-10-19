import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi() as ReturnType<typeof makeApi> & { drsClients: ReturnType<typeof vi.fn> };
fakeApi.drsClients = vi.fn();

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => makeApp(),
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { ClientsPage } = await import('./clients-page.js');

describe('client dossiers', () => {
  it('lists each client with its assessments, targets and last state', async () => {
    fakeApi.drsClients.mockResolvedValue({
      clients: [
        {
          client: 'acme',
          assessments: 3,
          finalized: 2,
          targets: ['https://a.example/', 'https://b.example/'],
          lastAt: '2026-10-19T20:00:00.000Z',
          lastState: 'FINAL_REPORT',
        },
      ],
    });
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByText('acme')).toBeTruthy();
    expect(screen.getByText('FINAL_REPORT')).toBeTruthy();
    expect(screen.getByText(/a\.example/)).toBeTruthy();
  });

  it('says there is no dossier yet', async () => {
    fakeApi.drsClients.mockResolvedValue({ clients: [] });
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByText(/No DRS assessment yet/)).toBeTruthy();
  });

  it('surfaces a load failure', async () => {
    fakeApi.drsClients.mockRejectedValue(new Error('authentication required'));
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('authentication required');
  });
});
