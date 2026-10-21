import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

// makeApi already provides drsClients; reuse its mock instead of re-typing it.
const fakeApi = makeApi();
const drsClients = fakeApi.drsClients as unknown as ReturnType<typeof vi.fn>;
const drsCapacity = fakeApi.drsCapacity as unknown as ReturnType<typeof vi.fn>;
const drsReports = fakeApi.drsReports as unknown as ReturnType<typeof vi.fn>;
const createDrsClient = fakeApi.createDrsClient as unknown as ReturnType<typeof vi.fn>;

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
  drsReports.mockResolvedValue({ reports: [] });
  createDrsClient.mockReset();
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
          id: 'c1',
          client: 'acme',
          registered: true,
          contacts: [],
          scope: {
            reference: 'SOW-1',
            signedAt: '2026-10-02T10:00:00.000Z',
            targets: ['https://a.example/', 'https://b.example/'],
            maxRps: 8000,
          },
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
    expect(screen.getByText(/last FINAL_REPORT/)).toBeTruthy();
    expect(screen.getByText(/target\(s\)/)).toBeTruthy();
  });

  it('says there is no dossier yet', async () => {
    drsClients.mockResolvedValue({ clients: [] });
    renderWithRouter(<ClientsPage />);
    expect(await screen.findByText(/No client dossier yet/)).toBeTruthy();
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

describe('creating a dossier', () => {
  it('submits the signed scope and reports it', async () => {
    drsClients.mockResolvedValue({ clients: [] });
    createDrsClient.mockResolvedValue({ id: 'c9', name: 'Acme', contacts: [], scope: {} });
    renderWithRouter(<ClientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new client/i }));
    fireEvent.change(screen.getByPlaceholderText('Acme Payments'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByPlaceholderText('SOW-2026-10'), { target: { value: 'SOW-1' } });
    fireEvent.change(screen.getByPlaceholderText('S. Martin'), { target: { value: 'S. Martin' } });
    fireEvent.change(screen.getByPlaceholderText('s.martin@acme.eu'), {
      target: { value: 's.martin@acme.eu' },
    });
    fireEvent.change(screen.getByPlaceholderText(/pay\.acme\.eu/), {
      target: { value: 'https://pay.acme.eu' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create dossier/i }));
    await waitFor(() =>
      expect(createDrsClient).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Acme',
          contacts: [{ name: 'S. Martin', email: 's.martin@acme.eu' }],
          scope: expect.objectContaining({
            reference: 'SOW-1',
            targets: ['https://pay.acme.eu'],
            maxRps: 2000,
          }),
        }),
      ),
    );
  });
});
