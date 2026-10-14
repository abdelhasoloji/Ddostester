import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { makeApp } from './test-utils.js';
import { api } from './api.js';
import type { CampaignRun } from './api.js';
import { ReportsPage } from './reports-page.js';
let app = makeApp();
vi.mock('./context.js', () => ({ useApp: () => app }));
vi.mock('./pages.js', () => ({ PageHead: ({ title }: { title: string }) => <h1>{title}</h1> }));
const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  app = makeApp();
  vi.spyOn(api, 'listRuns').mockResolvedValue([]);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  writeText.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('retained results surface', () => {
  it('shows authenticated export URLs without putting a write token in the links', async () => {
    render(<ReportsPage />);
    expect(screen.getByRole('link', { name: 'Open compliance report' })).toHaveAttribute(
      'href',
      '/api/reports/compliance',
    );
    expect(screen.getByRole('link', { name: 'Export runs CSV' })).toHaveAttribute(
      'href',
      '/api/runs.csv',
    );
    await screen.findByText('No retained runs yet.');
  });
  it('orders actual retained runs for before/after selection and prevents self-comparison', async () => {
    const old = {
      runId: 'old',
      campaignId: 'c1',
      status: 'COMPLETED',
      generator: { finishedAt: '2026-10-13T00:00:00Z' },
    } as CampaignRun;
    const recent = {
      ...old,
      runId: 'new',
      generator: { finishedAt: '2026-10-14T00:00:00Z' },
    } as CampaignRun;
    vi.mocked(api.listRuns).mockResolvedValue([recent, old]);
    render(<ReportsPage />);
    expect(await screen.findByLabelText('Run A (before)')).toHaveValue('old');
    expect(screen.getByLabelText('Run B (after)')).toHaveValue('new');
    expect(screen.getByRole('link', { name: 'Compare selected runs' })).toHaveAttribute(
      'href',
      '/api/reports/compare?a=old&b=new',
    );
    fireEvent.change(screen.getByLabelText('Run B (after)'), { target: { value: 'old' } });
    expect(screen.queryByRole('link', { name: 'Compare selected runs' })).not.toBeInTheDocument();
  });
  it('never offers share-token creation in single mode', async () => {
    app = makeApp({ userMode: 'single' });
    const share = vi.spyOn(api, 'createShare');
    render(<ReportsPage />);
    await screen.findByText('No retained runs yet.');
    expect(screen.queryByRole('button', { name: 'Copy share link' })).not.toBeInTheDocument();
    expect(share).not.toHaveBeenCalled();
  });
  it('copies only the server-issued read-only report token and exposes load errors honestly', async () => {
    vi.spyOn(api, 'createShare').mockResolvedValue({
      authRequired: true,
      token: 'read-only-fixture',
    });
    vi.mocked(api.listRuns).mockRejectedValue(new Error('history unavailable'));
    render(<ReportsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('history unavailable');
    expect(screen.queryByText('No retained runs yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = new URL(writeText.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/reports/compliance');
    expect(url.searchParams.get('token')).toBe('read-only-fixture');
  });
});
