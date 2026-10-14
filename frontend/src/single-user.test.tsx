import { permissionsFor } from '../../backend/src/auth/rbac.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { Campaign } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi();
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});
const { canDo } = await import('./context.js');
const { CampaignList } = await import('./pages.js');
const { UsersCard } = await import('./settings-cards.js');
const { CampaignCard, ExecuteModal } = await import('./ui.js');
const c: Campaign = {
  id: 'single-campaign',
  name: 'IoT simulation',
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/health',
  vector: 'http-get',
  maxRps: 5,
  concurrency: 2,
  maxDurationSec: 60,
  createdBy: 'owner@lab.test',
  createdAt: new Date().toISOString(),
  status: 'PENDING_APPROVAL',
};
beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({
    userMode: 'single',
    authRequired: true,
    role: 'admin',
    identity: { email: 'owner@lab.test', role: 'admin' },
  });
});

describe('single-administrator interface', () => {
  it('mirrors expanded permissions without changing the team admin', () => {
    for (const perm of [
      'create',
      'approve',
      'execute',
      'targetAuthorize',
      'bench',
      'limits',
    ] as const) {
      expect(canDo('admin', perm, true, 'single', permissionsFor('admin'))).toBe(true);
      expect(canDo('viewer', perm, true, 'single', permissionsFor('viewer'))).toBe(false);
    }
    expect(canDo('admin', 'execute', true)).toBe(false); // Missing API capabilities fail closed.
  });
  it('keeps user management visible for the owner', () => {
    renderWithRouter(<UsersCard />);
    expect(screen.getByRole('heading', { name: 'Users & access' })).toBeInTheDocument();
    expect(fakeApi.listUsers).toHaveBeenCalledOnce();
  });
  it('offers a pending campaign run through confirmation rather than separate approval', () => {
    renderWithRouter(<CampaignCard c={c} />);
    expect(screen.queryByRole('button', { name: 'Approve / Reject' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    expect(currentApp.setConfirmExec).toHaveBeenCalledWith(c);
    expect(currentApp.execute).not.toHaveBeenCalled();
  });
  it('confirms all suite steps once before starting the assessment', async () => {
    const runSuite = vi.fn().mockResolvedValue({ started: true });
    Object.assign(fakeApi, { runSuite });
    currentApp = makeApp({
      ...currentApp,
      campaigns: [
        { ...c, suiteId: 'single-suite', suiteName: 'IoT fleet', suiteOrder: 0 },
        { ...c, id: 'second', suiteId: 'single-suite', suiteName: 'IoT fleet', suiteOrder: 1 },
      ],
    });
    renderWithRouter(<CampaignList />);
    const row = Array.from(document.querySelectorAll('tr.ct-row')).find((r) =>
      r.textContent?.includes('IoT fleet'),
    );
    fireEvent.click(row!);
    fireEvent.click(screen.getByRole('button', { name: /Run assessment/ }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm assessment' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    expect(runSuite).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(runSuite).toHaveBeenCalledWith('single-suite', true));
    expect(runSuite).toHaveBeenCalledOnce();
  });
  it('displays scope and budget and only launches after Run now', () => {
    currentApp = makeApp({ ...currentApp, confirmExec: c });
    renderWithRouter(<ExecuteModal />);
    expect(screen.getByRole('dialog', { name: 'Confirm run' })).toHaveTextContent('5 rps');
    expect(screen.getByRole('dialog')).toHaveTextContent('60s');
    expect(screen.getByRole('dialog')).toHaveTextContent('http://127.0.0.1/');
    expect(currentApp.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(currentApp.execute).toHaveBeenCalledOnce();
    expect(currentApp.execute).toHaveBeenCalledWith(c);
  });
});
