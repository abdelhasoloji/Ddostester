import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

/** A complete fake app context; override any field per test. Methods are spies. */
export function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    allowed: ['127.0.0.1', 'localhost'],
    // Test fixture value (not the app's config source of truth — that is the
    // backend's HARD_CAPS via /health). Mirrors DEFAULT_CAPS in api.ts.
    hardCaps: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    hardCapsCeiling: { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 },
    applyEffectiveCaps: vi.fn(),
    agentName: 'builtin-http',
    serverVersion: null,
    requireCisoApproval: false,
    notifications: [],
    protection: false,
    tlsInsecure: false,
    agents: [
      {
        id: 'builtin',
        name: 'builtin-http',
        available: true,
        multiPhase: true,
        flowCapable: true,
        description: 'Built-in bounded HTTP generator.',
      },
    ],
    authRequired: false,
    authChecked: true,
    identity: null,
    role: null,
    ready: true,
    anyRunning: false,
    campaigns: [],
    runs: {},
    wrsSeries: [],
    auditRows: [],
    busy: {},
    expanded: null,
    operator: 'op@wedos',
    confirmExec: null,
    approveFor: null,
    toasts: [],
    draftPreset: null,
    applyPreset: vi.fn(),
    clearDraftPreset: vi.fn(),
    setOperator: vi.fn(),
    setExpanded: vi.fn(),
    setConfirmExec: vi.fn(),
    setApproveFor: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    loadHistory: vi.fn(),
    loadAudit: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
    createCampaign: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    archiveSuite: vi.fn().mockResolvedValue(undefined),
    cisoApprove: vi.fn().mockResolvedValue(undefined),
    toggleDetails: vi.fn().mockResolvedValue(undefined),
    openDetail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A fake api object: reads resolve to empty, mutations resolve. Override as needed. */
export function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    playbooks: vi.fn().mockResolvedValue([]),
    suites: vi.fn().mockResolvedValue([]),
    listUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn().mockResolvedValue({}),
    updateUserRole: vi.fn().mockResolvedValue({}),
    deleteUser: vi.fn().mockResolvedValue({ deleted: 'x' }),
    createPlaybook: vi.fn().mockResolvedValue({}),
    deletePlaybook: vi.fn().mockResolvedValue({ deleted: 'x' }),
    instantiatePlaybook: vi.fn().mockResolvedValue({ suiteId: 's', campaigns: [] }),
    composeSuite: vi.fn().mockResolvedValue({ suiteId: 's', campaigns: [] }),
    notifyTest: vi.fn().mockResolvedValue({ delivered: true, sinks: [] }),
    verifyAudit: vi.fn().mockResolvedValue({ ok: true, count: 3, headHash: 'abc123def456' }),
    benchScenarios: vi
      .fn()
      .mockResolvedValue({ scenarios: [], dispatchEnabled: false, labTargets: [] }),
    benchRuns: vi.fn().mockResolvedValue({ runs: [] }),
    createBenchRun: vi.fn().mockResolvedValue({}),
    benchCoverage: vi.fn().mockResolvedValue({ coverage: [] }),
    recordBenchCoverage: vi.fn().mockResolvedValue({}),
    runSuite: vi.fn().mockResolvedValue({ suiteId: 's', steps: 3, started: true }),
    pauseSuite: vi.fn().mockResolvedValue({ suiteId: 's', paused: true }),
    resumeSuite: vi.fn().mockResolvedValue({ suiteId: 's', paused: false }),
    cancelSuite: vi.fn().mockResolvedValue({ suiteId: 's', cancelled: true, killedCurrent: true }),
    suiteSequences: vi.fn().mockResolvedValue({ sequences: {} }),
    observabilitySummary: vi.fn().mockResolvedValue([]),
    metricsRange: vi
      .fn()
      .mockResolvedValue({ name: '', title: '', unit: 'reqps', source: 'unavailable', series: [] }),
    ...overrides,
  };
}

export function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}
