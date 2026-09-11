import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { makeApp, makeApi } from './test-utils.js';
import type { Playbook } from './api.js';

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

const { NewCampaignWizard } = await import('./ui.js');

const threatPlaybook: Playbook = {
  id: 'threat-http2-continuation',
  name: 'HTTP/2 Continuation',
  category: 'Threat-informed',
  summary: 'Header-pressure shape.',
  when: '',
  drsLevel: 5,
  steps: [
    {
      name: 'Baseline',
      summary: '',
      maxRps: 100,
      concurrency: 20,
      maxDurationSec: 60,
      profile: 'constant',
      agent: 'builtin',
    },
    {
      name: 'Wave',
      summary: '',
      maxRps: 600,
      concurrency: 120,
      maxDurationSec: 120,
      profile: 'constant',
      agent: 'builtin',
    },
  ],
};

beforeEach(() => {
  currentApp = makeApp();
  fakeApi.playbooks.mockResolvedValue([threatPlaybook]);
  fakeApi.instantiatePlaybook.mockResolvedValue({ suiteId: 's1', campaigns: [{}, {}] });
  currentApp.createCampaign.mockClear();
  fakeApi.instantiatePlaybook.mockClear();
});
afterEach(() => cleanup());

function pickTarget() {
  // Objective step → choose Readiness, then pick an allowed host on the Target step.
  fireEvent.click(screen.getByRole('button', { name: /Readiness/ }));
  fireEvent.click(screen.getByRole('button', { name: '127.0.0.1' }));
}

describe('NewCampaignWizard', () => {
  it('renders the five objectives on the first step', () => {
    render(<NewCampaignWizard />);
    for (const t of ['Readiness', 'Capacity', 'Spike resilience', 'Threat-informed', 'Endurance']) {
      expect(screen.getByRole('button', { name: new RegExp(t) })).toBeInTheDocument();
    }
  });

  it('warns via a toast when the template catalogue fails to load', async () => {
    fakeApi.playbooks.mockRejectedValueOnce(new Error('offline'));
    render(<NewCampaignWizard onDone={vi.fn()} />);
    await waitFor(() =>
      expect(currentApp.push).toHaveBeenCalledWith('error', expect.stringMatching(/templates/i)),
    );
  });

  it('guides objective → target → template → review and creates a preset campaign', async () => {
    render(<NewCampaignWizard onDone={vi.fn()} />);
    pickTarget();
    // Target is now allowed → advance to the template step.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // A recommendation is shown and a template is pre-selected (first run → gentlest).
    expect(await screen.findByText(/Recommended/)).toBeInTheDocument();
    expect(screen.getByText(/first run/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Review → attest → create.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Create campaign/ }));
    await waitFor(() => expect(currentApp.createCampaign).toHaveBeenCalledTimes(1));
    const payload = currentApp.createCampaign.mock.calls[0][0];
    expect(payload.target).toBe('https://127.0.0.1/');
    expect(payload.authorized).toBe(true);
    expect(payload.maxRps).toBe(10); // smoke preset (gentlest readiness template)
  });

  it('creates a suite via instantiatePlaybook for the threat objective', async () => {
    render(<NewCampaignWizard onDone={vi.fn()} />);
    // Wait for playbooks to load, then choose the Threat objective.
    await waitFor(() => expect(fakeApi.playbooks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Threat-informed/ }));
    fireEvent.click(screen.getByRole('button', { name: '127.0.0.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // The threat playbook appears as a suite template and is auto-selected.
    expect((await screen.findAllByText(/HTTP\/2 Continuation/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Create assessment/ }));
    await waitFor(() => expect(fakeApi.instantiatePlaybook).toHaveBeenCalledTimes(1));
    expect(fakeApi.instantiatePlaybook.mock.calls[0][0]).toBe('threat-http2-continuation');
  });

  it('blocks a target that is not in the allowlist', () => {
    render(<NewCampaignWizard />);
    fireEvent.click(screen.getByRole('button', { name: /Readiness/ }));
    // Exact placeholder → the Target input only (the Probe input placeholder is
    // ".../health", which the old regex also matched — an ambiguous, flaky query).
    fireEvent.change(screen.getByPlaceholderText('https://staging.example.com/'), {
      target: { value: 'https://evil.example/' },
    });
    expect(screen.getByText(/not in the allowlist/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});
