import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { ProtectedTarget } from './api.js';

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
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const { ZonesPage } = await import('./zones-page.js');

const target = (over: Partial<ProtectedTarget>): ProtectedTarget => ({
  id: 't1',
  host: 'app.customer.eu',
  createdBy: 'eng@x',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  authStatus: 'unauthorized',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // authRequired:false → canDo returns true for every perm (dev mode), so the
  // full management + authorization surface renders.
  currentApp = makeApp({});
  fakeApi.zones.mockResolvedValue([]);
});

describe('TargetsPanel (Protected Zones)', () => {
  it('lists registered targets with their authorization status', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [
        target({ host: 'app.customer.eu', authStatus: 'authorized', authorizedBy: 'ciso@x' }),
      ],
      envAllowlist: ['bank.cz'],
    });
    renderWithRouter(<ZonesPage />);
    expect(await screen.findByText('app.customer.eu')).toBeInTheDocument();
    expect(
      within(screen.getByText('app.customer.eu').closest('li')!).getByText(/^Authorized$/),
    ).toBeInTheDocument();
  });

  it('registers a new target with an authorization request', async () => {
    fakeApi.targets.mockResolvedValue({ targets: [], envAllowlist: [] });
    fakeApi.registerTarget.mockResolvedValue(
      target({ id: 't9', host: 'new.eu', authStatus: 'requested', authRequestedBy: 'op@wedos' }),
    );
    renderWithRouter(<ZonesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add target/ }));
    fireEvent.change(screen.getByPlaceholderText('app.customer.eu'), {
      target: { value: 'new.eu' },
    });
    fireEvent.change(screen.getByPlaceholderText(/I attest WEDOS is authorized/), {
      target: { value: 'WEDOS mandated to test this host, signed RoE on file.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Register & request/ }));
    await waitFor(() =>
      expect(fakeApi.registerTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'new.eu',
          attestation: expect.stringContaining('mandated'),
        }),
      ),
    );
    expect(await screen.findByText('new.eu')).toBeInTheDocument();
  });

  it('lets a CISO authorize a requested target', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'requested', authRequestedBy: 'eng@x' })],
      envAllowlist: [],
    });
    fakeApi.authorizeTarget.mockResolvedValue(
      target({ authStatus: 'authorized', authorizedBy: 'op@wedos' }),
    );
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(fakeApi.authorizeTarget).toHaveBeenCalledWith('t1'));
    await waitFor(() =>
      expect(
        within(screen.getByText('app.customer.eu').closest('li')!).getByText(/^Authorized$/),
      ).toBeInTheDocument(),
    );
  });

  it('lets a CISO revoke an authorized target', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'authorized', authorizedBy: 'ciso@x' })],
      envAllowlist: [],
    });
    fakeApi.revokeTarget.mockResolvedValue(
      target({ authStatus: 'revoked', revokedBy: 'op@wedos' }),
    );
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fakeApi.revokeTarget).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText(/^Revoked$/)).toBeInTheDocument();
  });

  it('requests authorization on an existing target via the inline attestation', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'unauthorized' })],
      envAllowlist: [],
    });
    fakeApi.requestTargetAuth.mockResolvedValue(target({ authStatus: 'requested' }));
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request authorization' }));
    const box = screen.getByPlaceholderText(/Authorization attestation/);
    // Under 10 chars keeps submit disabled.
    fireEvent.change(box, { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled();
    fireEvent.change(box, {
      target: { value: 'authorized to test this host per signed mandate.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() =>
      expect(fakeApi.requestTargetAuth).toHaveBeenCalledWith(
        't1',
        expect.stringContaining('mandate'),
      ),
    );
  });

  it('edits a target’s metadata inline', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'authorized', displayName: 'Old name' })],
      envAllowlist: [],
    });
    fakeApi.updateTarget.mockResolvedValue(
      target({ authStatus: 'authorized', displayName: 'New name' }),
    );
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Zone name'), { target: { value: 'New name' } });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'soc@fake' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fakeApi.updateTarget).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ displayName: 'New name', owner: 'soc@fake' }),
      ),
    );
    expect(await screen.findByText('New name')).toBeInTheDocument();
  });

  it('deletes a non-authorized target', async () => {
    fakeApi.targets.mockResolvedValue({
      targets: [target({ authStatus: 'revoked' })],
      envAllowlist: [],
    });
    fakeApi.deleteTarget.mockResolvedValue({ ok: true });
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fakeApi.deleteTarget).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByText('app.customer.eu')).not.toBeInTheDocument());
  });

  it('surfaces a load failure with a retry', async () => {
    fakeApi.targets.mockRejectedValueOnce(new Error('offline'));
    renderWithRouter(<ZonesPage />);
    await waitFor(() => expect(screen.getByText(/Couldn't load targets/)).toBeInTheDocument());
    fakeApi.targets.mockResolvedValue({
      targets: [target({ host: 'back.eu' })],
      envAllowlist: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Authorization filter'), { target: { value: 'all' } });
    expect(await screen.findByText('back.eu')).toBeInTheDocument();
  });
});
