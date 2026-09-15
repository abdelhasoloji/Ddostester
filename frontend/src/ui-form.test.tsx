import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp } from './test-utils.js';

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
