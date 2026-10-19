import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';
import type { DrsCapacityView } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
// makeApi provides drsCapacity; saveCalibration is page-specific.
const fakeApi = makeApi();
const drsCapacityMock = fakeApi.drsCapacity as unknown as ReturnType<typeof vi.fn>;
const saveCalibrationMock = vi.fn();
(fakeApi as unknown as { saveCalibration: unknown }).saveCalibration = saveCalibrationMock;

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { CapacityPage } = await import('./capacity-page.js');

const view = (over: Partial<DrsCapacityView> = {}): DrsCapacityView => ({
  ceiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
  scope: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900, targets: [] },
  envelope: {
    maxRps: 2000,
    maxConcurrency: 320,
    maxDurationSec: 900,
    agents: 1,
    limitedBy: { rps: 'scope', concurrency: 'capacity' },
    warnings: ['Scope asks for 2000 rps but admitted capacity is 9600 rps; fine.'],
  },
  calibrations: [
    {
      agentId: 'dev-a',
      measuredTps: 12_000,
      measuredConcurrency: 400,
      measuredAt: '2026-10-19T19:22:34.930Z',
      conditions: 'loopback',
    },
  ],
  reachability: [
    {
      level: 1,
      total: 2,
      reachable: 0,
      unreachable: [{ vectorId: 'http-get', missing: ['10 bots (1 admitted)'] }],
    },
  ],
  ...over,
});

beforeEach(() => {
  currentApp = makeApp();
  drsCapacityMock.mockReset();
  saveCalibrationMock.mockReset();
});

describe('Capacity page', () => {
  it('shows the envelope, what bounds it and the per-level gap', async () => {
    drsCapacityMock.mockResolvedValue(view());
    renderWithRouter(<CapacityPage />);
    // The envelope and the service ceiling are both 2,000 in this fixture.
    expect(await screen.findAllByText('2,000')).toHaveLength(2);
    expect(screen.getByText('320')).toBeTruthy();
    expect(screen.getByText(/bounded by/i)).toBeTruthy();
    expect(screen.getByText('0/2')).toBeTruthy();
    expect(screen.getByText(/10 bots \(1 admitted\)/)).toBeTruthy();
    expect(screen.getByText('dev-a')).toBeTruthy();
  });

  it('says the envelope is zero when nothing is calibrated', async () => {
    drsCapacityMock.mockResolvedValue(
      view({
        envelope: {
          maxRps: 0,
          maxConcurrency: 0,
          maxDurationSec: 900,
          agents: 0,
          limitedBy: { rps: 'capacity', concurrency: 'capacity' },
          warnings: ['No admitted agent: capacity is zero and no exposure can start.'],
        },
        calibrations: [],
        reachability: [],
      }),
    );
    renderWithRouter(<CapacityPage />);
    expect(await screen.findByText(/No calibration recorded yet/)).toBeTruthy();
    expect(screen.getByText(/capacity is zero/)).toBeTruthy();
  });

  it('records a calibration and reloads the envelope', async () => {
    drsCapacityMock.mockResolvedValueOnce(view()).mockResolvedValue(view());
    saveCalibrationMock.mockResolvedValue({});
    renderWithRouter(<CapacityPage />);
    await screen.findByText('dev-a');
    fireEvent.change(screen.getByPlaceholderText('site-a'), { target: { value: 'site-b' } });
    const numbers = screen.getAllByRole('spinbutton');
    fireEvent.change(numbers[0], { target: { value: '9000' } });
    fireEvent.change(numbers[1], { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /record/i }));
    await waitFor(() => expect(saveCalibrationMock).toHaveBeenCalledTimes(1));
    const payload = saveCalibrationMock.mock.calls[0][0];
    expect(payload.agentId).toBe('site-b');
    expect(payload.measuredTps).toBe(9000);
    expect(payload.measuredConcurrency).toBe(250);
    await waitFor(() => expect(drsCapacityMock).toHaveBeenCalledTimes(2));
  });

  it('surfaces a load failure instead of an empty screen', async () => {
    drsCapacityMock.mockRejectedValue(new Error('authentication required'));
    renderWithRouter(<CapacityPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('authentication required');
  });
});

describe('DRS plan creation from the Capacity screen', () => {
  it('keeps the button disabled until the plan is authorized and justified', async () => {
    drsCapacityMock.mockResolvedValue(view());
    renderWithRouter(<CapacityPage />);
    await screen.findByText('dev-a');
    const button = screen.getByRole('button', { name: /create plan/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('posts the intent once authorized and reports the created plan', async () => {
    drsCapacityMock.mockResolvedValue(view());
    (fakeApi as unknown as { createDrsPlan: ReturnType<typeof vi.fn> }).createDrsPlan = vi
      .fn()
      .mockResolvedValue({ id: 'c1', name: 'DRS L1 — staging', status: 'PENDING_APPROVAL' });
    renderWithRouter(<CapacityPage />);
    await screen.findByText('dev-a');
    fireEvent.change(screen.getByPlaceholderText('https://staging.example.com/'), {
      target: { value: 'https://staging.example.com/' },
    });
    fireEvent.change(screen.getByPlaceholderText("status 200 and body contains 'ok'"), {
      target: { value: 'status 200 and body contains ok' },
    });
    fireEvent.change(screen.getByPlaceholderText('why this level and this exposure'), {
      target: { value: 'Validate the level with a bounded exposure' },
    });
    fireEvent.click(screen.getByLabelText(/authorized target/i));
    const button = screen.getByRole('button', { name: /create plan/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        (fakeApi as unknown as { createDrsPlan: ReturnType<typeof vi.fn> }).createDrsPlan,
      ).toHaveBeenCalledTimes(1),
    );
    const payload = (fakeApi as unknown as { createDrsPlan: ReturnType<typeof vi.fn> })
      .createDrsPlan.mock.calls[0][0];
    expect(payload.maxLevel).toBe(1);
    expect(payload.authorized).toBe(true);
    expect(payload.functionalAssertion).toContain('status 200');
    expect(currentApp.push).toHaveBeenCalledWith('success', expect.stringContaining('DRS L1'));
  });
});
