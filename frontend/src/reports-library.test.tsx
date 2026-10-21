import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsReports = fakeApi.drsReports as unknown as ReturnType<typeof vi.fn>;

vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { ReportsLibraryPage } = await import('./reports-library.js');

describe('reports library', () => {
  it('lists finalised revisions with their three deliverables', async () => {
    drsReports.mockResolvedValue({
      reports: [
        {
          campaignId: 'c1',
          campaignName: 'DRS L1 — pay.acme.eu',
          client: 'Acme Payments',
          target: 'https://pay.acme.eu',
          mode: 'measured',
          revision: 1,
          level: 1,
          finalizedAt: '2026-10-21T10:00:00.000Z',
          status: 'PARTIAL',
          proofs: 1,
          synthetic: false,
        },
      ],
    });
    renderWithRouter(<ReportsLibraryPage />);
    expect((await screen.findAllByText('Acme Payments')).length).toBeGreaterThan(0);
    expect(screen.getByText('PARTIAL')).toBeTruthy();
    expect(screen.getByText('Bundle')).toHaveAttribute('href', '/api/campaigns/c1/drs/bundle');
    expect(screen.getByText('JSON')).toHaveAttribute('href', '/api/campaigns/c1/drs/report.json');
  });

  it('says there is nothing to deliver yet', async () => {
    drsReports.mockResolvedValue({ reports: [] });
    renderWithRouter(<ReportsLibraryPage />);
    expect(await screen.findByText(/No report yet/)).toBeTruthy();
  });
});
