import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { api } from './api.js';
import { makeApp } from './test-utils.js';

// ExecuteModal now uses useNavigate to jump to Run Theater on launch, so renders
// need a Router in context.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});

const { NewCampaignForm, ApproveModal, ExecuteModal } = await import('./ui.js');

beforeEach(() => {
  currentApp = makeApp();
});

describe('NewCampaignForm', () => {
  it('submits a seeded sensor draft with explicit engine and unchanged budgets after attestation', async () => {
    render(<NewCampaignForm initial={{ name: 'Sensor draft', maxRps: 2, concurrency: 1 }} />);
    fireEvent.change(screen.getByLabelText('Synthetic device journey'), {
      target: { value: 'sensor-heartbeat/v1' },
    });
    fireEvent.change(screen.getByLabelText('Device index'), { target: { value: '7' } });
    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toMatchObject({
      agent: 'builtin',
      vector: 'http-post',
      maxRps: 2,
      concurrency: 1,
      iotProfile: { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 7 },
    });
    expect(payload.flow).toBeUndefined();
  });

  it('preserves a conflicting body and blocks the sensor draft instead of discarding it', () => {
    render(<NewCampaignForm initial={{ name: 'Existing draft', body: 'keep this body' }} />);
    fireEvent.change(screen.getByLabelText('Synthetic device journey'), {
      target: { value: 'sensor-heartbeat/v1' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    expect(screen.getByDisplayValue('keep this body')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('clear custom body');
    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeDisabled();
    expect(currentApp.createCampaign).not.toHaveBeenCalled();
  });

  it('renders the built-in-only realism fields (endpoint mix, UA rotation, feeder)', () => {
    render(<NewCampaignForm />);
    expect(screen.getByRole('heading', { name: 'New campaign' })).toBeInTheDocument();
    expect(screen.getByText(/Endpoint mix/)).toBeInTheDocument();
    expect(screen.getByText(/User-Agent rotation/)).toBeInTheDocument();
    expect(screen.getByText(/Data feeder/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeInTheDocument();
  });

  it('submits a valid campaign through the context', async () => {
    render(<NewCampaignForm />);
    // Name is the first text field; target/probe default to an allowed host.
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'My run' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i })); // attestation
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'My run', authorized: true });
  });

  it('keeps Submit disabled until attested', () => {
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeDisabled();
  });

  it('hides the probe-vantage toggle when no remote agent is configured', () => {
    currentApp = makeApp({ remoteProbe: false });
    render(<NewCampaignForm />);
    expect(screen.queryByText('Probe vantage')).not.toBeInTheDocument();
  });

  it('shows the probe-vantage toggle and flows remote into the payload when configured', async () => {
    currentApp = makeApp({ remoteProbe: true });
    render(<NewCampaignForm />);
    expect(screen.getByText('Probe vantage')).toBeInTheDocument();
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'ENISA run' } });
    // There are several selects; find the one holding the vantage options.
    const vantage = Array.from(document.querySelectorAll('select')).find((el) =>
      el.textContent?.includes('Remote agent'),
    ) as HTMLSelectElement;
    fireEvent.change(vantage, { target: { value: 'remote' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toMatchObject({ probeVantage: 'remote' });
  });

  it('omits probeVantage from the payload when left local', async () => {
    currentApp = makeApp({ remoteProbe: true });
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'local run' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.probeVantage).toBeUndefined();
  });

  it('switching preset updates the Name field when it is still preset-owned', () => {
    render(<NewCampaignForm />);
    const nameInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    // Pick a preset → its name lands in the field.
    fireEvent.click(screen.getByRole('button', { name: /Smoke test/ }));
    expect(nameInput.value).toBe('Smoke test');
    // Switch to another preset → the name follows, it does not stay stuck.
    fireEvent.click(screen.getByRole('button', { name: /Capacity ceiling/ }));
    expect(nameInput.value).toBe('Capacity ceiling');
  });

  it('a preset switch preserves a name the operator typed themselves', () => {
    render(<NewCampaignForm />);
    const nameInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: /Smoke test/ }));
    // Operator types a custom name over the preset one.
    fireEvent.change(nameInput, { target: { value: 'My bespoke run' } });
    fireEvent.click(screen.getByRole('button', { name: /Capacity ceiling/ }));
    expect(nameInput.value).toBe('My bespoke run');
  });

  it('the Auto-calibrate toggle flows calibrate:true into the submitted payload (GEN-1)', async () => {
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'calib run' } });
    // Toggle the auto-calibrate delivery lever, then attest and submit.
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-calibrate rate/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.calibrate).toBe(true);
  });

  it('omits calibrate from the payload when the toggle is left off', async () => {
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'no calib' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = (currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.calibrate).toBeUndefined();
  });

  // E13 — config-time delivery hint. builtinCeilings default = { rps 150, conc 300 }.
  it('shows no delivery hint when the rate is within the built-in ceiling', () => {
    render(<NewCampaignForm />); // default maxRps 20
    expect(screen.queryByText(/auto-routes|under-deliver/i)).not.toBeInTheDocument();
  });

  it('predicts an auto-route for a simple high-rate flood', () => {
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '800' } });
    expect(screen.getByText(/auto-routes to an out-of-process engine/i)).toBeInTheDocument();
  });

  it('warns that a built-in-only feature (UA rotation) can’t route and will under-deliver', () => {
    render(<NewCampaignForm />);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '800' } });
    fireEvent.change(screen.getByPlaceholderText(/One User-Agent per line/i), {
      target: { value: 'Mozilla/5.0 test' },
    });
    expect(
      screen.getByText(/can’t route to Vegeta\/k6 and will under-deliver/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/auto-routes to an out-of-process engine/i)).not.toBeInTheDocument();
  });
});

describe('modals', () => {
  it('ApproveModal shows the campaign and blocks self-approval', () => {
    const campaign = {
      id: 'c1',
      name: 'Cap ceiling',
      createdBy: 'off@wedos',
      target: 'https://h/',
      status: 'PENDING_APPROVAL',
    };
    currentApp = makeApp({
      approveFor: campaign,
      authRequired: true,
      identity: { email: 'off@wedos', role: 'ciso' },
    });
    render(<ApproveModal />);
    expect(screen.getByText(/Approval/)).toBeInTheDocument();
    expect(screen.getByText(/Separation of duties/)).toBeInTheDocument();
  });

  it('ExecuteModal renders the confirmation with the bounded load', () => {
    currentApp = makeApp({
      confirmExec: {
        id: 'c1',
        name: 'run',
        target: 'https://h/',
        maxRps: 50,
        concurrency: 10,
        maxDurationSec: 30,
      },
    });
    render(<ExecuteModal />);
    expect(screen.getByText(/Confirm run/)).toBeInTheDocument();
    expect(screen.getByText(/50 rps/)).toBeInTheDocument();
  });

  it('ExecuteModal launch is one-shot — a double-click dispatches the run only once', () => {
    currentApp = makeApp({
      confirmExec: {
        id: 'c1',
        name: 'run',
        target: 'https://h/',
        maxRps: 50,
        concurrency: 10,
        maxDurationSec: 30,
      },
    });
    render(<ExecuteModal />);
    const launch = screen.getByRole('button', { name: /Run now/ });
    fireEvent.click(launch);
    fireEvent.click(launch); // impatient second click before navigation
    expect(currentApp.execute).toHaveBeenCalledTimes(1);
    // The modal is dismissed once launched.
    expect(currentApp.setConfirmExec).toHaveBeenCalledWith(null);
  });

  it('closes the ExecuteModal on Escape', () => {
    currentApp = makeApp({
      confirmExec: {
        id: 'c1',
        name: 'run',
        target: 'https://h/',
        maxRps: 50,
        concurrency: 10,
        maxDurationSec: 30,
      },
    });
    render(<ExecuteModal />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(currentApp.setConfirmExec).toHaveBeenCalledWith(null);
  });

  it('closes the ApproveModal on Escape', () => {
    currentApp = makeApp({
      approveFor: {
        id: 'c1',
        name: 'Cap ceiling',
        createdBy: 'off@wedos',
        target: 'https://h/',
        status: 'PENDING_APPROVAL',
      },
    });
    render(<ApproveModal />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(currentApp.setApproveFor).toHaveBeenCalledWith(null);
  });
});

it('offers two generator modes and requires review after switching a complex draft to Fleet', () => {
  currentApp = makeApp({
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
  render(
    <NewCampaignForm
      initial={{
        name: 'Copy',
        target: 'http://127.0.0.1:8080/health',
        probeUrl: 'http://127.0.0.1:8080/health',
        profile: 'wave',
        vector: 'http-post',
        body: 'retain until review',
        userAgents: 'custom',
        dataset: 'a\n1',
        recurrenceMin: '60',
        parallelism: 2,
      }}
    />,
  );
  expect(screen.getByLabelText('Generator')).toHaveValue('local');
  fireEvent.change(screen.getByLabelText('Generator'), { target: { value: 'fleet' } });
  expect(screen.getByRole('status')).toHaveTextContent('Review the scenario and total budget');
  expect(screen.queryByLabelText('Local engine')).not.toBeInTheDocument();
  expect(currentApp.createCampaign).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Generator'), { target: { value: 'local' } });
  expect(screen.getByLabelText('Local engine')).toHaveValue('builtin');
  expect(screen.queryByDisplayValue('retain until review')).not.toBeInTheDocument();
});

it('submits duplicated phases and structured data unchanged after a fresh attestation', async () => {
  const phases = [
    { maxRps: 1, durationSec: 7 },
    { maxRps: 3, durationSec: 13 },
  ];
  const endpoints = [{ method: 'GET', url: 'http://127.0.0.1:8080/health', weight: 2 }];
  const dataset = [{ value: 'with,comma' }];
  render(
    <NewCampaignForm
      initial={{
        name: 'Duplicate',
        agent: 'builtin',
        maxRps: 3,
        concurrency: 2,
        maxDurationSec: 20,
        profile: 'copied',
        copiedScenario: phases,
        endpoints: JSON.stringify(endpoints),
        dataset: JSON.stringify(dataset),
      }}
    />,
  );
  expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
  fireEvent.click(screen.getByRole('button', { name: /Submit for approval/ }));
  await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
  expect((currentApp.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
    scenario: phases,
    endpoints,
    dataset,
  });
});

it('creates only a marked DRS Fleet draft with explicit agents from different sites', async () => {
  currentApp = makeApp({
    drsWorkflow: true,
    role: 'admin',
    userMode: 'single',
    agents: [
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
  const devices = ['one', 'two'].map((id, i) => ({
    id,
    agentId: id,
    name: id,
    siteId: 'site-' + i,
    group: 'Remote site',
    profile: 'sensor' as const,
    privateIp: '10.0.0.1',
    notes: '',
    createdAt: '',
    updatedAt: '',
    connection: 'online' as const,
    agentVersion: 'fleet-mission-agent/v1',
  }));
  vi.spyOn(api, 'fleetOverview').mockResolvedValue({
    enabled: true,
    origins: ['http://127.0.0.1:8080'],
    observedAt: new Date().toISOString(),
    group: 'VPS Lab',
    caps: { maxRps: 15, maxConcurrency: 6, maxDurationSec: 60 },
    devices: [],
    missions: [],
  });
  vi.spyOn(api, 'fleetDevices').mockResolvedValue({ devices, total: 2 });
  vi.spyOn(api, 'fleetSites').mockResolvedValue({
    sites: [
      { id: 'site-0', devices: 1, online: 1 },
      { id: 'site-1', devices: 1, online: 1 },
    ],
    devices: 2,
    limits: { maxDevices: 5000, maxSites: 100, pageSize: 100 },
  });
  try {
    render(
      <NewCampaignForm
        initial={{
          name: 'DRS GET',
          drsProfileId: 'cra-l7-get-flood',
          agent: 'fleet',
          fleetDeviceIds: ['one', 'two'],
          maxRps: 3,
          concurrency: 3,
          maxDurationSec: 20,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Use one')).toBeInTheDocument());
    expect(screen.getByLabelText('Generator')).toBeDisabled();
    expect(screen.queryByText('Start from a preset:')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /attest/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    expect(currentApp.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        drsProfileId: 'cra-l7-get-flood',
        agent: 'fleet',
        fleetDeviceIds: ['one', 'two'],
        maxRps: 3,
      }),
    );
  } finally {
    vi.restoreAllMocks();
  }
});
