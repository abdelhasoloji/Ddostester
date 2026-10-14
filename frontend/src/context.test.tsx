import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Campaign } from './api.js';

const fakeApi = {
  health: vi.fn(),
  agents: vi.fn(),
  listCampaigns: vi.fn(),
  wrsHistory: vi.fn(),
  audit: vi.fn(),
  alerts: vi.fn().mockResolvedValue([]),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue({ ok: true }),
  changePassword: vi.fn(),
  createCampaign: vi.fn(),
  approve: vi.fn(),
  execute: vi.fn(),
  kill: vi.fn(),
  getRun: vi.fn(),
};

vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi, setToken: vi.fn(), getToken: vi.fn(() => null) };
});

const apiMod = await import('./api.js');
const { AppProvider, useApp, canDo } = await import('./context.js');

const camp = { id: 'c1', name: 'Camp', runId: 'r1' } as unknown as Campaign;

function Harness() {
  const app = useApp();
  return (
    <div>
      <span data-testid="ready">{String(app.ready)}</span>
      <span data-testid="expanded">{app.expanded ?? ''}</span>
      <span data-testid="identity">{app.identity?.email ?? 'none'}</span>
      <span data-testid="campaigns">{app.campaigns.length}</span>
      <span data-testid="allowed">{app.allowed.join(',')}</span>
      <span data-testid="audit">{app.auditRows?.length ?? -1}</span>
      <span data-testid="toasts">{app.toasts.length}</span>
      <span data-testid="operator">{app.operator}</span>
      <button onClick={() => void app.login('e', 'p')}>login</button>
      <button onClick={() => app.logout()}>logout</button>
      <button onClick={() => void app.createCampaign({ name: 'n' })}>create</button>
      <button onClick={() => void app.approve(camp, 'off', 'APPROVED', 'ok')}>approve</button>
      <button onClick={() => void app.execute(camp)}>execute</button>
      <button onClick={() => void app.kill(camp)}>kill</button>
      <button onClick={() => void app.toggleDetails(camp)}>toggle</button>
      <button onClick={() => void app.openDetail(camp)}>open</button>
      <button onClick={() => app.loadAudit()}>audit</button>
      <button onClick={() => app.loadHistory()}>history</button>
      <button onClick={() => app.refresh()}>refresh</button>
      <button onClick={() => void app.refreshHealth()}>refreshHealth</button>
      <button onClick={() => app.push('info', 'hi')}>toast</button>
      <button onClick={() => app.setOperator('op2')}>operator</button>
    </div>
  );
}

function mount() {
  return render(
    <AppProvider>
      <Harness />
    </AppProvider>,
  );
}
async function mountReady() {
  mount();
  await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (apiMod.getToken as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
  fakeApi.health.mockResolvedValue({ allowedTargets: ['h'], authRequired: false });
  fakeApi.agents.mockResolvedValue({ default: 'builtin', agents: [{ id: 'builtin' }] });
  fakeApi.listCampaigns.mockResolvedValue([]);
  fakeApi.wrsHistory.mockResolvedValue([]);
  fakeApi.alerts.mockResolvedValue([]);
  fakeApi.audit.mockResolvedValue([{ id: 'a1', at: 'now', actor: 'x', action: 'y' }]);
  fakeApi.me.mockResolvedValue({ email: 'off@wedos', role: 'ciso' });
  fakeApi.login.mockResolvedValue({ token: 'tok', email: 'off@wedos', role: 'ciso' });
  fakeApi.createCampaign.mockResolvedValue({});
  fakeApi.approve.mockResolvedValue({});
  fakeApi.execute.mockResolvedValue({ status: 'COMPLETED', wrs: { wrs: 90, level: 'A' } });
  fakeApi.kill.mockResolvedValue({ status: 'KILLED_MANUAL' });
  fakeApi.getRun.mockResolvedValue({ runId: 'r1' });
});

describe('canDo', () => {
  it('allows everything when auth is off', () => {
    expect(canDo(null, 'approve', false)).toBe(true);
  });
  it('enforces the role matrix when auth is on', () => {
    expect(canDo('ciso', 'approve', true, 'team', ['campaign:approve'])).toBe(true);
    expect(canDo('engineer', 'approve', true)).toBe(false);
    expect(canDo('viewer', 'create', true)).toBe(false);
    expect(canDo(null, 'kill', true)).toBe(false);
  });
});

describe('useApp guard', () => {
  it('throws when used outside a provider', () => {
    function Bare() {
      useApp();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow(/useApp used outside provider/);
    spy.mockRestore();
  });
});

describe('AppProvider bootstrap', () => {
  it('loads health + agents, then refreshes campaigns and history once ready', async () => {
    await mountReady();
    expect(fakeApi.health).toHaveBeenCalled();
    expect(fakeApi.agents).toHaveBeenCalled();
    await waitFor(() => expect(fakeApi.listCampaigns).toHaveBeenCalled());
    expect(fakeApi.wrsHistory).toHaveBeenCalled();
  });

  it('resolves identity via me() when auth is required and a token is stored', async () => {
    (apiMod.getToken as unknown as ReturnType<typeof vi.fn>).mockReturnValue('tok');
    fakeApi.health.mockResolvedValue({ allowedTargets: [], authRequired: true });
    mount();
    await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('off@wedos'));
  });

  it('clears the token when the stored session is invalid', async () => {
    (apiMod.getToken as unknown as ReturnType<typeof vi.fn>).mockReturnValue('tok');
    fakeApi.health.mockResolvedValue({ allowedTargets: [], authRequired: true });
    fakeApi.me.mockResolvedValue({ email: null, role: null });
    mount();
    await waitFor(() => expect(apiMod.setToken).toHaveBeenCalledWith(null));
    expect(screen.getByTestId('identity').textContent).toBe('none');
  });

  it('clears the token when me() throws', async () => {
    (apiMod.getToken as unknown as ReturnType<typeof vi.fn>).mockReturnValue('tok');
    fakeApi.health.mockResolvedValue({ allowedTargets: [], authRequired: true });
    fakeApi.me.mockRejectedValue(new Error('expired'));
    mount();
    await waitFor(() => expect(apiMod.setToken).toHaveBeenCalledWith(null));
  });

  it('surfaces a refresh failure as a toast', async () => {
    fakeApi.listCampaigns.mockRejectedValue(new Error('down'));
    await mountReady();
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('1'));
  });

  it('refreshHealth re-fetches /health and updates the effective allowlist', async () => {
    await mountReady();
    expect(screen.getByTestId('allowed').textContent).toBe('h');
    // A target authorized after load widens the effective allowlist on the server.
    fakeApi.health.mockResolvedValue({
      allowedTargets: ['h', 'sandbox.trustena.lu'],
      authRequired: false,
    });
    fireEvent.click(screen.getByText('refreshHealth'));
    await waitFor(() =>
      expect(screen.getByTestId('allowed').textContent).toBe('h,sandbox.trustena.lu'),
    );
  });

  it('refreshHealth keeps the last-known posture when /health fails', async () => {
    await mountReady();
    expect(screen.getByTestId('allowed').textContent).toBe('h');
    fakeApi.health.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByText('refreshHealth'));
    // No throw, allowlist unchanged.
    await waitFor(() => expect(fakeApi.health).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('allowed').textContent).toBe('h');
  });
});

describe('auth actions', () => {
  it('login sets the identity', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('off@wedos'));
    expect(apiMod.setToken).toHaveBeenCalledWith('tok');
  });

  it('logout clears identity and campaigns', async () => {
    fakeApi.listCampaigns.mockResolvedValue([camp]);
    await mountReady();
    fireEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('off@wedos'));
    fireEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(screen.getByTestId('identity').textContent).toBe('none'));
    expect(screen.getByTestId('campaigns').textContent).toBe('0');
  });
});

describe('campaign actions', () => {
  it('createCampaign posts with the operator and shows a toast', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('create'));
    await waitFor(() => expect(fakeApi.createCampaign).toHaveBeenCalled());
    const payload = fakeApi.createCampaign.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ name: 'n' });
    expect('createdBy' in payload).toBe(true);
  });

  it('execute records the run and toasts', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('execute'));
    await waitFor(() => expect(fakeApi.execute).toHaveBeenCalledWith('c1'));
  });

  it('does NOT open the card drawer on launch (the launcher routes to Run Theater instead)', async () => {
    // The live view now lives in Run Theater; ExecuteModal navigates there, so
    // context.execute must not steal focus by expanding the card drawer.
    let finish!: (v: unknown) => void;
    fakeApi.execute.mockReturnValue(new Promise((r) => (finish = r)));
    await mountReady();
    fireEvent.click(screen.getByText('execute'));
    await waitFor(() => expect(fakeApi.execute).toHaveBeenCalledWith('c1'));
    // Drawer stays closed while the run is in flight.
    expect(screen.getByTestId('expanded').textContent).toBe('');
    finish({ status: 'COMPLETED', wrs: { wrs: 90, level: 'A' } });
    // And still closed after it settles.
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(''));
  });

  it('execute surfaces an error as a toast', async () => {
    fakeApi.execute.mockRejectedValue(new Error('cap exceeded'));
    await mountReady();
    fireEvent.click(screen.getByText('execute'));
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('1'));
  });

  it('approve calls the api', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('approve'));
    await waitFor(() => expect(fakeApi.approve).toHaveBeenCalledWith('c1', expect.any(Object)));
  });

  it('approve surfaces an error as a toast', async () => {
    fakeApi.approve.mockRejectedValue(new Error('self-approval'));
    await mountReady();
    fireEvent.click(screen.getByText('approve'));
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('1'));
  });

  it('kill calls the api and toasts', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('kill'));
    await waitFor(() => expect(fakeApi.kill).toHaveBeenCalledWith('c1'));
  });

  it('kill surfaces an error as a toast', async () => {
    fakeApi.kill.mockRejectedValue(new Error('gone'));
    await mountReady();
    fireEvent.click(screen.getByText('kill'));
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('1'));
  });

  it('toggleDetails opens then closes, fetching the run once', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe('c1'));
    expect(fakeApi.getRun).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(''));
  });

  it('openDetail always opens', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe('c1'));
  });
});

describe('data loaders and misc', () => {
  it('loadAudit populates the audit rows', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('audit'));
    await waitFor(() => expect(screen.getByTestId('audit').textContent).toBe('1'));
  });

  it('loadAudit surfaces an error as a toast', async () => {
    fakeApi.audit.mockRejectedValue(new Error('nope'));
    await mountReady();
    fireEvent.click(screen.getByText('audit'));
    await waitFor(() => expect(screen.getByTestId('toasts').textContent).toBe('1'));
  });

  it('setOperator persists to localStorage', async () => {
    await mountReady();
    fireEvent.click(screen.getByText('operator'));
    await waitFor(() => expect(screen.getByTestId('operator').textContent).toBe('op2'));
    expect(localStorage.getItem('operator')).toBe('op2');
  });

  it('push adds a toast and removes it after 5s', async () => {
    vi.useFakeTimers();
    try {
      mount();
      // Flush the mount-time async effects under fake timers.
      await vi.runOnlyPendingTimersAsync();
      fireEvent.click(screen.getByText('toast'));
      expect(screen.getByTestId('toasts').textContent).toBe('1');
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId('toasts').textContent).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });
});
