import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

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

const { SettingsPage, GuidePage } = await import('./pages.js');

beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({
    authRequired: true,
    role: 'officer',
    identity: { email: 'off@wedos', role: 'officer' },
    allowed: ['staging.wedos'],
    notifications: ['slack'],
  });
  fakeApi.listUsers.mockResolvedValue([
    { email: 'eng@wedos', role: 'engineer', source: 'store' },
    { email: 'root@wedos', role: 'officer', source: 'env' },
  ]);
  fakeApi.notifyTest.mockResolvedValue({ delivered: true, sinks: ['slack'] });
  fakeApi.instantiatePlaybook.mockResolvedValue({ suiteId: 's', campaigns: [{}, {}] });
  fakeApi.playbooks.mockResolvedValue([
    {
      id: 'pb1',
      name: 'Ramp',
      category: 'Baseline',
      summary: 'A bounded ramp',
      when: 'Before a release',
      steps: [
        {
          name: 'warm-up',
          summary: '',
          maxRps: 10,
          concurrency: 2,
          maxDurationSec: 10,
          profile: 'ramp',
        },
      ],
    },
  ]);
});

describe('UsersCard interactions', () => {
  it('changes a store user role through the dropdown', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.change(screen.getByTitle('Change role'), { target: { value: 'officer' } });
    await waitFor(() =>
      expect(fakeApi.updateUserRole).toHaveBeenCalledWith('eng@wedos', 'officer'),
    );
  });

  it('removes a store user', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fakeApi.deleteUser).toHaveBeenCalledWith('eng@wedos'));
  });

  it('adds a new user', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('first.last@wedos'), {
      target: { value: 'new@wedos' },
    });
    fireEvent.change(screen.getByPlaceholderText('min. 8 characters'), {
      target: { value: 'password1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add / update user' }));
    await waitFor(() =>
      expect(fakeApi.createUser).toHaveBeenCalledWith({
        email: 'new@wedos',
        role: 'viewer',
        password: 'password1',
      }),
    );
  });

  it('surfaces a listUsers failure as a toast', async () => {
    fakeApi.listUsers.mockRejectedValue(new Error('forbidden'));
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(currentApp.push).toHaveBeenCalledWith('error', 'forbidden'));
  });
});

describe('NotificationsCard', () => {
  it('sends a test notification', async () => {
    renderWithRouter(<SettingsPage />);
    const btn = await screen.findByRole('button', { name: 'Send test notification' });
    fireEvent.click(btn);
    await waitFor(() => expect(fakeApi.notifyTest).toHaveBeenCalled());
  });
});

describe('PlaybooksSection', () => {
  it('launches an assessment for an allowlisted target', async () => {
    renderWithRouter(<GuidePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'staging.wedos' }));
    fireEvent.click(await screen.findByRole('button', { name: /Launch assessment/ }));
    await waitFor(() =>
      expect(fakeApi.instantiatePlaybook).toHaveBeenCalledWith(
        'pb1',
        expect.objectContaining({ target: 'https://staging.wedos/' }),
      ),
    );
  });
});
