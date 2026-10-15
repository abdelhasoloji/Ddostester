import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi } from './test-utils.js';
import type { AssistantAction } from './assistant-action.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi();
const mockNavigate = vi.fn();

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
  return { ...actual, useNavigate: () => mockNavigate };
});

const { AssistantActionCard } = await import('./assistant-action-card.js');

// authRequired:false → canDo() is true for every role, so the full governed
// surface renders; allowed hosts include 127.0.0.1.
beforeEach(() => {
  vi.clearAllMocks();
  currentApp = makeApp({});
});

const campaignAction = (over: string[] = []): AssistantAction => ({
  kind: 'campaign',
  title: 'Baseline',
  rationale: 'conservative baseline',
  over,
  rows: [],
  seed: {
    name: 'Baseline',
    target: 'http://127.0.0.1/',
    probeUrl: 'http://127.0.0.1/health',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 5,
    maxDurationSec: 60,
  },
});

describe('AssistantActionCard — campaign', () => {
  it('blocks submission when the server rejects a versioned proposal', async () => {
    const action = {
      ...campaignAction(),
      proposal: { schema: 'ddostester.kusa.proposal/v1', type: 'test-campaign', approved: true },
    };
    fakeApi.validateAssistantProposal.mockRejectedValueOnce(
      new Error('Unsupported proposal fields'),
    );
    render(<AssistantActionCard action={action} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await screen.findByText(/Unsupported proposal fields/);
    expect(fakeApi.validateAssistantProposal).toHaveBeenCalledWith(action.proposal);
    expect(fakeApi.createCampaign).not.toHaveBeenCalled();
  });
  it('runs the full governed cycle inline: submit → approve → run → result', async () => {
    fakeApi.createCampaign.mockResolvedValue({ id: 'c1', status: 'PENDING_APPROVAL' });
    fakeApi.approve.mockResolvedValue({ id: 'c1', status: 'APPROVED' });
    fakeApi.execute.mockResolvedValue({
      runId: 'r1',
      status: 'COMPLETED',
      wrs: { wrs: 99.4, level: 'A+' },
    });
    render(<AssistantActionCard action={campaignAction()} />);

    // Submit is gated on the attestation.
    const submit = screen.getByRole('button', { name: /Submit for approval/ });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(fakeApi.createCampaign).toHaveBeenCalled());
    expect(fakeApi.createCampaign.mock.calls[0][0]).toMatchObject({
      target: 'http://127.0.0.1/',
      authorized: true,
    });

    // PENDING_APPROVAL → approve.
    const approve = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    await waitFor(() => expect(fakeApi.approve).toHaveBeenCalledWith('c1', expect.any(Object)));

    // APPROVED → run.
    const run = await screen.findByRole('button', { name: /Run now/ });
    fireEvent.click(run);
    await waitFor(() => expect(fakeApi.execute).toHaveBeenCalledWith('c1'));

    // Result surfaces the WRS.
    expect(await screen.findByText(/99.4 \(A\+\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open Run Theater/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/theater');
  });

  it('flags a target host not in the allowlist and blocks submit', () => {
    const a = campaignAction();
    (a as { seed: { target: string } }).seed.target = 'http://evil.example/';
    render(<AssistantActionCard action={a} />);
    expect(screen.getByText(/Host not in allowlist/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeDisabled();
  });

  it('requires a reason to reject', async () => {
    fakeApi.createCampaign.mockResolvedValue({ id: 'c2', status: 'PENDING_APPROVAL' });
    render(<AssistantActionCard action={campaignAction()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    const reject = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(reject);
    expect(await screen.findByText(/reason is required/i)).toBeInTheDocument();
    expect(fakeApi.approve).not.toHaveBeenCalled();
  });
});

describe('AssistantActionCard — target', () => {
  it('shows "already authorized" for an allowlisted host', () => {
    currentApp = makeApp({ allowed: ['46.28.109.92'] });
    const a: AssistantAction = {
      kind: 'target',
      title: 'VPS3',
      rationale: '',
      rows: [{ label: 'Host', value: '46.28.109.92', mono: true }],
      draft: { host: '46.28.109.92' },
    };
    render(<AssistantActionCard action={a} />);
    expect(screen.getByText(/Already an authorized target/)).toBeInTheDocument();
  });

  it('registers then authorizes a new target', async () => {
    fakeApi.registerTarget.mockResolvedValue({ id: 't9', host: 'new.eu', authStatus: 'requested' });
    fakeApi.authorizeTarget.mockResolvedValue({
      id: 't9',
      host: 'new.eu',
      authStatus: 'authorized',
      authorizedBy: 'ciso@x',
    });
    const a: AssistantAction = {
      kind: 'target',
      title: 'New',
      rationale: '',
      rows: [],
      draft: { host: 'new.eu', displayName: 'New Zone' },
    };
    render(<AssistantActionCard action={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Register target/ }));
    await waitFor(() => expect(fakeApi.registerTarget).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Authorize/ }));
    await waitFor(() => expect(fakeApi.authorizeTarget).toHaveBeenCalledWith('t9'));
    expect(await screen.findByText(/Registered and authorized/)).toBeInTheDocument();
  });
});

describe('AssistantActionCard — limits & navigate', () => {
  it('applies operational limits', async () => {
    fakeApi.setLimits.mockResolvedValue({});
    const a: AssistantAction = {
      kind: 'limits',
      title: 'Tighten',
      rationale: '',
      rows: [],
      over: [],
      caps: { maxRps: 500, maxConcurrency: 100, maxDurationSec: 300 },
    };
    render(<AssistantActionCard action={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Apply limits/ }));
    await waitFor(() =>
      expect(fakeApi.setLimits).toHaveBeenCalledWith(
        expect.objectContaining({ maxRps: 500, maxConcurrency: 100, maxDurationSec: 300 }),
      ),
    );
    expect(await screen.findByText(/Applied/)).toBeInTheDocument();
  });

  it('blocks limits above the ceiling', () => {
    const a: AssistantAction = {
      kind: 'limits',
      title: 'Too high',
      rationale: '',
      rows: [],
      over: ['maxRps'],
      caps: { maxRps: 9999, maxConcurrency: 100, maxDurationSec: 300 },
    };
    render(<AssistantActionCard action={a} />);
    expect(screen.getByText(/Above the safety ceiling/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply limits/ })).toBeDisabled();
  });

  it('navigates from a navigate action', () => {
    const a: AssistantAction = {
      kind: 'navigate',
      title: 'Go to Theater',
      rationale: '',
      rows: [],
      to: '/theater',
      screen: 'Run Theater',
    };
    render(<AssistantActionCard action={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Run Theater/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/theater');
  });
});

it('routes single-admin launches through explicit confirmation instead of executing an assistant proposal', async () => {
  currentApp = makeApp({
    role: 'admin',
    userMode: 'single',
    authRequired: true,
    identity: { email: 'abdelha@wedos' },
  });
  fakeApi.createCampaign.mockResolvedValue({ id: 'single-fixture', status: 'PENDING_APPROVAL' });
  render(<AssistantActionCard action={campaignAction()} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  expect(currentApp.setConfirmExec).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'single-fixture' }),
  );
  expect(fakeApi.execute).not.toHaveBeenCalled();
});
it('retains approval and co-sign failures and permits a manual stop after an ambiguous launch error', async () => {
  currentApp = makeApp({ requireCisoApproval: true });
  fakeApi.createCampaign.mockResolvedValue({ id: 'error-fixture', status: 'PENDING_APPROVAL' });
  fakeApi.approve
    .mockRejectedValueOnce(Error('Approval unavailable'))
    .mockResolvedValue({ id: 'error-fixture', status: 'APPROVED' });
  fakeApi.cisoApprove
    .mockRejectedValueOnce(Error('Co-sign unavailable'))
    .mockResolvedValue({ id: 'error-fixture', status: 'APPROVED', cisoApprovedBy: 'fixture-ciso' });
  fakeApi.execute.mockRejectedValue(Error('Launch response lost'));
  fakeApi.listCampaigns.mockResolvedValue([{ id: 'error-fixture', status: 'RUNNING' }]);
  fakeApi.kill
    .mockRejectedValueOnce(Error('Stop response lost'))
    .mockResolvedValue({ status: 'STOPPING' });
  render(<AssistantActionCard action={campaignAction()} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await screen.findByText(/Approval unavailable/);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  fireEvent.click(await screen.findByRole('button', { name: /CISO sign-off/ }));
  await screen.findByText(/Co-sign unavailable/);
  fireEvent.click(screen.getByRole('button', { name: /CISO sign-off/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  await screen.findByText(/Launch response lost/);
  fireEvent.click(await screen.findByRole('button', { name: 'Kill switch' }));
  await screen.findByText(/Stop response lost/);
  fireEvent.click(screen.getByRole('button', { name: 'Kill switch' }));
  await waitFor(() =>
    expect(currentApp.push).toHaveBeenCalledWith('info', 'Kill switch triggered.'),
  );
  expect(fakeApi.listCampaigns).toHaveBeenCalled();
});
it('does not authorize a target or mark limits applied after a rejected request', async () => {
  const target: AssistantAction = {
    kind: 'target',
    title: 'New target',
    draft: { host: 'fixture.internal' },
    rows: [],
    rationale: '',
  };
  fakeApi.registerTarget
    .mockRejectedValueOnce(Error('Registration unavailable'))
    .mockResolvedValue({ id: 'target-fixture', authStatus: 'pending' });
  fakeApi.authorizeTarget
    .mockRejectedValueOnce(Error('Authorization unavailable'))
    .mockResolvedValue({ id: 'target-fixture', authStatus: 'authorized' });
  const view = render(<AssistantActionCard action={target} />);
  fireEvent.change(screen.getByPlaceholderText('Written authorization reference / note'), {
    target: { value: 'fixture-authority' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Register target' }));
  await screen.findByText(/Registration unavailable/);
  expect(fakeApi.authorizeTarget).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Register target' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Authorize (CISO)' }));
  await screen.findByText(/Authorization unavailable/);
  expect(screen.queryByText(/Registered and authorized/)).not.toBeInTheDocument();
  view.unmount();
  fakeApi.setLimits.mockRejectedValue(Error('Limits update rejected'));
  render(
    <AssistantActionCard
      action={{
        kind: 'limits',
        title: 'Limits fixture',
        caps: { maxRps: 10, maxConcurrency: 3, maxDurationSec: 10 },
        over: [],
        rows: [],
        rationale: '',
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply limits' }));
  await screen.findByText(/Limits update rejected/);
  expect(screen.queryByText('✓ Applied.')).not.toBeInTheDocument();
  expect(currentApp.applyEffectiveCaps).not.toHaveBeenCalled();
});
