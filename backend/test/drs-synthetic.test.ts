import { describe, expect, it } from 'vitest';
import {
  createRevision,
  currentRevision,
  defaultPlan,
  freeze,
} from '../src/modules/drs/workflow.js';
import { runSyntheticValidation } from '../src/modules/drs/synthetic.js';
import { drsReport } from '../src/modules/drs/report.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

// A synthetic run does not observe a baseline; keep the floor low so the plan can freeze.
process.env.DRS_BASELINE_FLOOR_SEC = '5';

const campaign = {
  id: 'c1',
  name: 'synthetic fixture',
  status: 'PENDING_APPROVAL',
  createdBy: 'fixture',
  createdAt: new Date().toISOString(),
  target: 'http://127.0.0.1:9/',
  probeUrl: 'http://127.0.0.1:9/',
  authorized: true,
  vector: 'http-get',
  maxRps: 100,
  concurrency: 4,
  maxDurationSec: 5,
} as unknown as Campaign;

const frozen = (mode: 'synthetic-lab' | 'measured') => {
  const plan = defaultPlan(campaign, mode);
  plan.exposureSec = 1;
  plan.baselineMinSec = 5;
  const doc = createRevision(undefined, plan, 'fixture');
  const revision = currentRevision(doc);
  freeze(revision, campaign);
  return revision;
};

describe('synthetic amplifier validation', () => {
  it('measures what the engine really produces and produces no verdict', async () => {
    const revision = frozen('synthetic-lab');
    const budget = revision.plan.budgets;
    let stopped = false;

    const validation = await runSyntheticValidation(revision, 'fixture', {
      generator: (url) => ({
        capacity: async () => ({ ready: true, reason: '' }),
        start: async () => {
          // Emit what the budget claims, directly against the sink the runner opened.
          const total = Math.max(10, budget.maxRps * 1);
          for (let i = 0; i < total; i += 10) {
            await Promise.all(
              Array.from({ length: Math.min(10, total - i) }, () =>
                fetch(url).then((r) => r.text()),
              ),
            );
          }
          return {
            stop: async () => {
              stopped = true;
              return { confirmed: true, stoppedAt: new Date().toISOString() };
            },
          };
        },
      }),
      signal: new AbortController().signal,
      checkpoint: async () => {},
    });

    expect(stopped).toBe(true);
    expect(revision.state).toBe('ENGINE_VALIDATED');
    expect(validation.produced.requests).toBeGreaterThan(0);
    expect(validation.fidelity).toBeGreaterThan(0);
    expect(validation.fidelity).toBeLessThanOrEqual(1);
    expect(validation.controls.map((c) => c.id)).toEqual([
      'rate',
      'concurrency',
      'plan-integrity',
      'exclusions',
    ]);
    expect(validation.controls.find((c) => c.id === 'plan-integrity')?.ok).toBe(true);
    expect(validation.hash).toMatch(/^[0-9a-f]{64}$/);

    // No assessment, no verdict: the report carries the validation instead.
    const report = drsReport(revision);
    expect(report.assessment).toBeNull();
    expect(report.synthetic?.fidelity).toBe(validation.fidelity);
  });

  it('refuses to run a measured plan as synthetic', async () => {
    const revision = frozen('measured');
    await expect(
      runSyntheticValidation(revision, 'fixture', {
        generator: () => ({
          capacity: async () => ({ ready: true, reason: '' }),
          start: async () => ({ stop: async () => ({ confirmed: true, stoppedAt: '' }) }),
        }),
        signal: new AbortController().signal,
        checkpoint: async () => {},
      }),
    ).rejects.toThrow(/synthetic-lab/);
  });
});
