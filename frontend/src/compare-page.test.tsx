import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { makeApp, makeApi, renderWithRouter } from './test-utils.js';

const fakeApi = makeApi();
const drsCompare = fakeApi.drsCompare as unknown as ReturnType<typeof vi.fn>;

vi.mock('./context.js', async (orig) => ({
  ...(await orig<typeof import('./context.js')>()),
  useApp: () => makeApp(),
}));
vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof import('./api.js')>()),
  api: fakeApi,
}));

const { ComparePage } = await import('./compare-page.js');

const side = (name: string, status: string, level: number, proofs: number) => ({
  campaignId: name,
  name,
  target: 'https://pay.acme.eu',
  revision: 1,
  finalizedAt: '2026-10-20T10:00:00.000Z',
  status,
  score: null,
  terminalLevel: level,
  terminalOutcome: status,
  proofs,
});

describe('comparison screen', () => {
  it('states what improved, what is still unmet and what regressed', async () => {
    drsCompare.mockResolvedValue({
      a: side('First run', 'PARTIAL', 1, 1),
      b: side('Second run', 'PARTIAL', 1, 1),
      deltas: {
        statusChanged: false,
        levelChange: 0,
        proofDelta: 0,
        gapsResolved: [{ vectorId: 'drs-3.00.00-151002', dimension: 'load' }],
        gapsRemaining: [{ vectorId: 'drs-3.00.00-151002', dimension: 'sources' }],
        gapsRegressed: [],
      },
    });
    renderWithRouter(<ComparePage />, {
      route: '/assessments/a/compare/b',
      path: '/assessments/:id/compare/:with',
    });
    expect(await screen.findByText(/1 requirement\(s\) resolved/)).toBeTruthy();
    expect(screen.getByText(/drs-3\.00\.00-151002 load/)).toBeTruthy();
    expect(screen.getByText(/drs-3\.00\.00-151002 sources/)).toBeTruthy();
    expect(screen.getByText(/went from/)).toBeTruthy();
  });
});
