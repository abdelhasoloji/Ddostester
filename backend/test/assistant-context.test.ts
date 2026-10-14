import { expect, it } from 'vitest';
import {
  assistantTargetOrigin,
  assistantMeasurementSummary,
  assistantLatestRun,
} from '../src/modules/assistant/context.js';
it('selects the newest campaign measurement independently of store ordering', () => {
  const older = { campaignId: 'c', generator: { finishedAt: '2026-10-12T00:00:00Z' } };
  const newer = { campaignId: 'c', generator: { finishedAt: '2026-10-13T00:00:00Z' } };
  expect(assistantLatestRun([older, newer], 'c')).toBe(newer);
  expect(assistantLatestRun([newer, older], 'c')).toBe(newer);
  expect(assistantLatestRun([{ campaignId: 'other', generator: {} }], 'c')).toBeUndefined();
  expect(assistantLatestRun([newer, { campaignId: 'c', generator: {} }], 'c')).toBeUndefined();
});
it('excludes URL credentials, sensitive paths, query tokens and fragments from model summaries', () => {
  const value = assistantTargetOrigin(
    'https://user:password@lab.example:8443/private-secret?token=private-secret#private-secret',
  );
  expect(value).toBe('https://lab.example:8443');
  expect(value).not.toMatch(/password|private-secret|user/);
  expect(assistantTargetOrigin('javascript:private-secret')).toBe('unknown');
  expect(assistantTargetOrigin('not a URL')).toBe('unknown');
});
it('withholds cached scores when the latest measurement is missing, interrupted or degraded', () => {
  const complete = { status: 'COMPLETED', generator: {}, wrs: { wrs: 80, level: 'B' } };
  expect(assistantMeasurementSummary(complete)).toBe('WRS 80');
  expect(assistantMeasurementSummary({ ...complete, wrs: { wrs: 500, level: 'B' } })).toBe(
    'WRS unavailable',
  );
  expect(assistantMeasurementSummary()).toContain('unavailable');
  for (const run of [
    { ...complete, generator: { fleet: { measurementComplete: false } } },
    { ...complete, status: 'KILLED_MANUAL' },
    { ...complete, confidence: { degraded: true } },
    { ...complete, assessment: { verdict: 'inconclusive' } },
  ]) {
    expect(assistantMeasurementSummary(run)).toContain('WRS withheld');
    expect(assistantMeasurementSummary(run)).not.toContain('80');
  }
  expect(
    assistantMeasurementSummary({ ...complete, wrs: { ...complete.wrs, estimated: true } }),
  ).toBe('Estimated WRS 80');
});
