import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsFleet = fakeApi.drsFleet as unknown as ReturnType<typeof vi.fn>;
const setDrsAgentState = fakeApi.setDrsAgentState as unknown as ReturnType<typeof vi.fn>;

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => currentApp,
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { DrsFleetPage } = await import('./drs-fleet-page.js');

const agent = (over: Record<string, unknown>) => ({
  id: 'gen-1',
  label: 'gen-1',
  region: null,
  tags: [],
  state: 'active',
  registered: true,
  measuredTps: 6000,
  measuredConcurrency: 200,
  measuredAt: '2026-10-18T00:00:00.000Z',
  conditions: null,
  ageDays: 3,
  admitted: true,
  excludedReason: null,
  excludedDetail: null,
  ...over,
});

describe('fleet', () => {
  it('admits an active agent and explains why another is excluded', async () => {
    currentApp = makeApp();
    drsFleet.mockResolvedValue({
      ttlDays: 30,
      envelope: { maxRps: 4800, maxConcurrency: 160, agents: 1 },
      agents: [
        agent({}),
        agent({
          id: 'gen-old',
          label: 'gen-old',
          state: 'maintenance',
          admitted: false,
          excludedReason: 'maintenance',
          excludedDetail: 'agent in maintenance',
        }),
      ],
    });
    renderWithRouter(<DrsFleetPage />);
    expect(await screen.findByText('admitted')).toBeTruthy();
    // the state appears in both the select option and the chip
    expect(screen.getAllByText('maintenance').length).toBeGreaterThan(1);
    expect(screen.getByText(/agent in maintenance/)).toBeTruthy();
    expect(screen.getByText('4,800')).toBeTruthy();
  });

  it('changes an agent state from the table', async () => {
    currentApp = makeApp();
    drsFleet.mockResolvedValue({
      ttlDays: 30,
      envelope: { maxRps: 4800, maxConcurrency: 160, agents: 1 },
      agents: [agent({})],
    });
    setDrsAgentState.mockResolvedValue({ id: 'gen-1', state: 'maintenance' });
    renderWithRouter(<DrsFleetPage />);
    const select = await screen.findByLabelText('State of gen-1');
    fireEvent.change(select, { target: { value: 'maintenance' } });
    await waitFor(() => expect(setDrsAgentState).toHaveBeenCalledWith('gen-1', 'maintenance'));
  });
});
