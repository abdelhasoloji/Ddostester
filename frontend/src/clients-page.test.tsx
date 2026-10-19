import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

// makeApi already provides drsClients; reuse its mock instead of re-typing it.
const fakeApi = makeApi();
const drsClients = fakeApi.drsClients as unknown as ReturnType<typeof vi.fn>;
const drsCapacity = fakeApi.drsCapacity as unknown as ReturnType<typeof vi.fn>;

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => makeApp(),
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { ClientsPage } = await import('./clients-page.js');

beforeEach(() => {
  drsCapacity.mockResolvedValue({
    ceiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    scope: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900, targets: [] },
    envelope: {
      maxRps: 9600,
      maxConcurrency: 320,
      maxDurationSec: 900,
      agents: 2,
      limitedBy: { rps: 'capacity', concurrency: 'capacity' },
      warnings: [],
    },
    calibrations: [],
    reachability: [],
  });
});

describe('client dossiers', () => {
  it('lists each client with its assessments, targets and last state', async () => {
    drsClients.mockResolvedValue({
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
    drsClients.mockResolvedValue({ clients: [] });
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByText(/No DRS assessment yet/)).toBeTruthy();
  });

  it('surfaces a load failure', async () => {
    drsClients.mockRejectedValue(new Error('authentication required'));
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('authentication required');
  });
});

describe('capacity strip', () => {
  it('shows the envelope and what bounds it', async () => {
    drsClients.mockResolvedValue({ clients: [] });
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByText(/9,600 rps/)).toBeTruthy();
    expect(screen.getByText(/admitted agent/)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });
});
