import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
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

const { TemplatesPage } = await import('./templates-page.js');

const xlayerPb: Playbook = {
  id: 'xlayer-full-assurance',
  name: 'Cross-layer full assurance',
  category: 'Threat-informed',
  summary: 'L7 + class-C.',
  when: 'full-stack',
  drsLevel: 5,
  companionBench: { ladder: 'network-drs345', note: 'the class-C half' },
  steps: [
    {
      name: 'GET-Flood',
      summary: 's',
      maxRps: 400,
      concurrency: 80,
      maxDurationSec: 120,
      profile: 'constant',
    },
  ],
} as unknown as Playbook;

beforeEach(() => {
  vi.clearAllMocks();
  fakeApi.playbooks = vi.fn().mockResolvedValue([xlayerPb]);
});

describe('TemplatesPage — class-C ladder launch', () => {
  it('a CISO with the lab configured can request the ladder → one bench run per reproducible vector', async () => {
    fakeApi.benchScenarios = vi.fn().mockResolvedValue({
      dispatchEnabled: true,
      labTargets: ['lab.internal'],
      scenarios: [
        {
          id: 'udp_ntp_reflection',
          title: 'NTP',
          proto: 'UDP',
          drs: 3,
          reproducible: true,
          note: '',
        },
        { id: 'ip_spoofing', title: 'spoof', proto: 'IP', drs: 4, reproducible: false, note: '' },
      ],
      ladders: [
        {
          id: 'network-drs345',
          title: 'net',
          summary: '',
          // Includes a non-reproducible vector that must be skipped.
          scenarios: ['udp_ntp_reflection', 'ip_spoofing'],
        },
      ],
    });
    fakeApi.createBenchRun = vi.fn().mockResolvedValue({});
    currentApp = makeApp({ role: 'ciso', authRequired: true });
    renderWithRouter(<TemplatesPage />);

    // Expand the cross-layer template row, then request the ladder.
    const row = await screen.findByText('Cross-layer full assurance');
    fireEvent.click(row);
    const btn = await screen.findByRole('button', { name: /Request class-C ladder/i });
    fireEvent.click(btn);

    await waitFor(() => expect(fakeApi.createBenchRun).toHaveBeenCalledWith('udp_ntp_reflection'));
    // The non-reproducible vector is never dispatched.
    expect(fakeApi.createBenchRun).toHaveBeenCalledTimes(1);
    expect(fakeApi.createBenchRun).not.toHaveBeenCalledWith('ip_spoofing');
  });

  it('shows the "enable the lab runner" note instead of the button when dispatch is disabled', async () => {
    fakeApi.benchScenarios = vi
      .fn()
      .mockResolvedValue({ dispatchEnabled: false, labTargets: [], scenarios: [], ladders: [] });
    currentApp = makeApp({ role: 'ciso', authRequired: true });
    renderWithRouter(<TemplatesPage />);
    const row = await screen.findByText('Cross-layer full assurance');
    fireEvent.click(row);
    expect(await screen.findByText(/Enable the lab runner/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request class-C ladder/i })).toBeNull();
  });

  it('an engineer (no bench permission) sees neither the button nor the note', async () => {
    currentApp = makeApp({ role: 'engineer', authRequired: true });
    renderWithRouter(<TemplatesPage />);
    const row = await screen.findByText('Cross-layer full assurance');
    fireEvent.click(row);
    // The companion box still shows (informational), but no launch affordance.
    expect(screen.queryByRole('button', { name: /Request class-C ladder/i })).toBeNull();
    expect(screen.queryByText(/Enable the lab runner/i)).toBeNull();
  });
});
