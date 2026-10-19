import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useLocation } from 'react-router-dom';
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

const { SettingsPage, AccountPage, AuditLog } = await import('./pages.js');
const { TemplatesPage } = await import('./templates-page.js');

beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({
    authRequired: true,
    role: 'admin',
    identity: { email: 'off@wedos', role: 'admin' },
    allowed: ['staging.wedos'],
    notifications: ['slack'],
  });
  fakeApi.listUsers.mockResolvedValue([
    { email: 'eng@wedos', role: 'engineer', source: 'store' },
    { email: 'root@wedos', role: 'ciso', source: 'env' },
  ]);
  fakeApi.notifyTest.mockResolvedValue({ delivered: true, sinks: ['slack'] });
  fakeApi.instantiatePlaybook.mockResolvedValue({ suiteId: 's', campaigns: [{}, {}] });
  fakeApi.composeSuite.mockResolvedValue({ suiteId: 's', campaigns: [{}, {}] });
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

/** Two templates — the compose tests need at least two to select. */
const twoPlaybooks = [
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
  {
    id: 'pb2',
    name: 'Soak',
    category: 'Endurance',
    summary: 'A long steady soak',
    when: 'Overnight',
    steps: [
      {
        name: 'hold',
        summary: '',
        maxRps: 20,
        concurrency: 4,
        maxDurationSec: 30,
        profile: 'constant',
      },
    ],
  },
];

describe('UsersCard interactions', () => {
  it('filters active and disabled accounts without mutating users', async () => {
    fakeApi.listUsers.mockResolvedValue([
      { email: 'eng@wedos', role: 'engineer', source: 'store' },
      { email: 'inactive@wedos', role: 'viewer', source: 'store', status: 'disabled' },
    ]);
    renderWithRouter(<SettingsPage />);
    await screen.findByText('inactive@wedos');
    const filter = screen.getByLabelText('Account status');
    fireEvent.change(filter, { target: { value: 'active' } });
    expect(screen.getByText('eng@wedos')).toBeInTheDocument();
    expect(screen.queryByText('inactive@wedos')).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'disabled' } });
    expect(screen.getByText('inactive@wedos')).toBeInTheDocument();
    expect(screen.queryByText('eng@wedos')).not.toBeInTheDocument();
    expect(fakeApi.setUserStatus).not.toHaveBeenCalled();
    expect(fakeApi.updateUserRole).not.toHaveBeenCalled();
  });

  it('changes a store user role through the dropdown', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.change(screen.getByTitle('Change role'), { target: { value: 'ciso' } });
    await waitFor(() => expect(fakeApi.updateUserRole).toHaveBeenCalledWith('eng@wedos', 'ciso'));
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
    fireEvent.change(screen.getByPlaceholderText('min. 12 characters'), {
      target: { value: 'Str0ngPass!234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() =>
      expect(fakeApi.createUser).toHaveBeenCalledWith({
        email: 'new@wedos',
        role: 'viewer',
        password: 'Str0ngPass!234',
      }),
    );
  });

  it('surfaces a listUsers failure as a toast', async () => {
    fakeApi.listUsers.mockRejectedValue(new Error('forbidden'));
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(currentApp.push).toHaveBeenCalledWith('error', 'forbidden'));
  });

  it('purges campaigns after a two-step confirm (officer)', async () => {
    renderWithRouter(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Purge…' }));
    // Nothing purged until the explicit confirm.
    expect(fakeApi.purgeCampaigns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm purge' }));
    await waitFor(() => expect(fakeApi.purgeCampaigns).toHaveBeenCalledWith('settled'));
  });

  it('deactivates a store user', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(fakeApi.setUserStatus).toHaveBeenCalledWith('eng@wedos', 'disabled'),
    );
  });

  it('resets a store user password to a temporary one', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('eng@wedos')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    fireEvent.change(screen.getByLabelText('New password for eng@wedos'), {
      target: { value: 'Str0ngPass!234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set temporary password' }));
    await waitFor(() =>
      expect(fakeApi.resetUserPassword).toHaveBeenCalledWith('eng@wedos', 'Str0ngPass!234'),
    );
  });
});

describe('ChangePasswordForm (self-service)', () => {
  it('blocks a mismatched confirmation', async () => {
    renderWithRouter(<AccountPage />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'oldpass12345' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Str0ngPass!234' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'different!2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(currentApp.changeOwnPassword).not.toHaveBeenCalled();
  });

  it('submits a matching change to the context', async () => {
    renderWithRouter(<AccountPage />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'oldpass12345' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Str0ngPass!234' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Str0ngPass!234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() =>
      expect(currentApp.changeOwnPassword).toHaveBeenCalledWith('oldpass12345', 'Str0ngPass!234'),
    );
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

describe('AuditLog integrity (hosted in Settings)', () => {
  it('verifies the chain and shows the intact badge', async () => {
    renderWithRouter(<AuditLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }));
    await waitFor(() => expect(fakeApi.verifyAudit).toHaveBeenCalled());
    expect(await screen.findByText(/Chain intact/)).toBeInTheDocument();
  });

  it('shows a tampering badge when the chain is broken', async () => {
    fakeApi.verifyAudit.mockResolvedValueOnce({
      ok: false,
      count: 3,
      headHash: 'x',
      brokenAt: { index: 1, id: 'e2', reason: 'content' },
    });
    renderWithRouter(<AuditLog />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByText(/Tampering detected/)).toBeInTheDocument();
  });
});

describe('TemplatesPage', () => {
  // Templates are created/launched by the engineer (create permission).
  beforeEach(() => {
    currentApp = makeApp({
      authRequired: true,
      role: 'engineer',
      identity: { email: 'eng@wedos', role: 'engineer' },
      allowed: ['staging.wedos'],
    });
  });

  it('launches an assessment for an allowlisted target', async () => {
    renderWithRouter(<TemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'staging.wedos' }));
    // Expand the (collapsed) template row, then launch.
    fireEvent.click(await screen.findByText('Ramp'));
    fireEvent.click(
      await screen.findByRole('button', { name: /Create (assessment|campaign)/, hidden: true }),
    );
    expect(fakeApi.instantiatePlaybook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create with Local generator' }));
    await waitFor(() =>
      expect(fakeApi.instantiatePlaybook).toHaveBeenCalledWith(
        'pb1',
        expect.objectContaining({ target: 'https://staging.wedos/' }),
      ),
    );
  });

  it('composes several selected templates into one campaign', async () => {
    fakeApi.playbooks.mockResolvedValue(twoPlaybooks);
    renderWithRouter(<TemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'staging.wedos' }));
    // Select two templates via their compose checkboxes (in order).
    fireEvent.click(await screen.findByLabelText('Select "Ramp" to compose'));
    fireEvent.click(await screen.findByLabelText('Select "Soak" to compose'));
    // The compose basket appears; launch the composition.
    fireEvent.click(await screen.findByRole('button', { name: /Create assessment/ }));
    expect(fakeApi.composeSuite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create with Local generator' }));
    await waitFor(() =>
      expect(fakeApi.composeSuite).toHaveBeenCalledWith(
        expect.objectContaining({
          playbookIds: ['pb1', 'pb2'],
          target: 'https://staging.wedos/',
        }),
      ),
    );
  });

  it('clears the compose selection', async () => {
    renderWithRouter(<TemplatesPage />);
    fireEvent.click(await screen.findByLabelText('Select "Ramp" to compose'));
    // Basket shows one selected; Clear empties it and hides the basket.
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument(),
    );
  });

  it('requires a two-step confirmation before deleting a custom template', async () => {
    fakeApi.playbooks.mockResolvedValue([
      { ...twoPlaybooks[0], id: 'mine', name: 'My template', custom: true },
    ]);
    fakeApi.deletePlaybook.mockResolvedValue(undefined);
    renderWithRouter(<TemplatesPage />);
    // First click arms the confirm — nothing is deleted yet.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(fakeApi.deletePlaybook).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete this template\?/)).toBeInTheDocument();
    // Confirm actually deletes.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fakeApi.deletePlaybook).toHaveBeenCalledWith('mine'));
  });

  it('can cancel a template deletion', async () => {
    fakeApi.playbooks.mockResolvedValue([
      { ...twoPlaybooks[0], id: 'mine', name: 'My template', custom: true },
    ]);
    renderWithRouter(<TemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Delete this template\?/)).not.toBeInTheDocument();
    expect(fakeApi.deletePlaybook).not.toHaveBeenCalled();
  });

  it('shows a loading hint until templates arrive', async () => {
    let resolve!: (v: unknown[]) => void;
    fakeApi.playbooks.mockReturnValue(new Promise((r) => (resolve = r)) as never);
    renderWithRouter(<TemplatesPage />);
    expect(screen.getByText(/Loading templates/)).toBeInTheDocument();
    resolve([]);
    await waitFor(() => expect(screen.queryByText(/Loading templates/)).not.toBeInTheDocument());
  });

  it('offers a Retry when the template load fails', async () => {
    fakeApi.playbooks.mockRejectedValueOnce(new Error('network down'));
    renderWithRouter(<TemplatesPage />);
    expect(await screen.findByText(/Couldn't load templates/)).toBeInTheDocument();
    // Retry re-fetches; this time it succeeds and the error clears.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't load templates/)).not.toBeInTheDocument(),
    );
    expect(fakeApi.playbooks).toHaveBeenCalledTimes(2);
  });
});

it('offers Fleet before creating a preset and forwards the target without silently instantiating its suite', async () => {
  currentApp = makeApp({
    authRequired: true,
    role: 'admin',
    userMode: 'single',
    allowed: ['staging.wedos'],
    agents: [
      ...makeApp().agents,
      {
        id: 'fleet',
        name: 'iot-fleet',
        available: true,
        multiPhase: false,
        flowCapable: false,
        description: 'Fleet',
      },
    ],
  });
  function Location() {
    const location = useLocation();
    return <output data-testid="destination">{location.pathname + location.search}</output>;
  }
  renderWithRouter(
    <>
      <TemplatesPage />
      <Location />
    </>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'staging.wedos' }));
  fireEvent.click(await screen.findByText('Ramp'));
  fireEvent.click(
    await screen.findByRole('button', { name: /Create (assessment|campaign)/, hidden: true }),
  );
  expect(screen.getByRole('dialog', { name: 'Choose campaign generator' })).toHaveTextContent(
    'Separate GET campaign',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review with IoT Fleet' }));
  expect(screen.getByTestId('destination')).toHaveTextContent(
    '/campaigns?engine=fleet&template=fleet-get&target=https%3A%2F%2Fstaging.wedos%2F',
  );
  expect(fakeApi.instantiatePlaybook).not.toHaveBeenCalled();
  expect(fakeApi.composeSuite).not.toHaveBeenCalled();
  expect(currentApp.clearDraftCampaign).toHaveBeenCalled();
});
