import { describe, expect, it } from 'vitest';
import {
  presetSeed,
  buildIoTProfile,
  emptyForm,
  duplicateCampaignSeed,
  parseDataset,
  parseEndpoints,
} from './campaign-form.js';
import type { Preset } from './presets.js';

const preset: Preset = {
  id: 'stress',
  name: 'Stress test',
  icon: '🔥',
  category: 'Stress',
  summary: '',
  when: '',
  maxRps: 800,
  concurrency: 150,
  maxDurationSec: 300,
  profile: 'ramp',
  recommendedAgent: 'k6',
};

it('builds explicit reproducibility parameters and rejects blank or fractional integers', () => {
  expect(buildIoTProfile(emptyForm)).toBeUndefined();
  const form = { ...emptyForm, iotProfile: 'sensor-heartbeat/v1' };
  expect(buildIoTProfile(form)).toEqual({ id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 0 });
  for (const over of [
    { iotSeed: '' },
    { iotSeed: '-1' },
    { iotSeed: '4294967296' },
    { iotDeviceIndex: '0.5' },
    { iotDeviceIndex: '1000' },
  ])
    expect(() => buildIoTProfile({ ...form, ...over })).toThrow();
});

describe('presetSeed', () => {
  it('carries the load shape but never a target', () => {
    const seed = presetSeed(preset, [{ id: 'k6', available: true }]);
    expect(seed).toMatchObject({
      name: 'Stress test',
      maxRps: 800,
      concurrency: 150,
      maxDurationSec: 300,
      profile: 'ramp',
    });
    // Safety: a preset seed must not pre-fill a target/probe (stays allowlisted).
    expect(seed.target).toBeUndefined();
    expect(seed.probeUrl).toBeUndefined();
  });

  it('applies the recommended engine only when it is installed and available', () => {
    expect(presetSeed(preset, [{ id: 'k6', available: true }]).agent).toBe('k6');
    // Not installed → no agent key, so the form keeps its default engine.
    expect(presetSeed(preset, [{ id: 'k6', available: false }]).agent).toBeUndefined();
    expect(presetSeed(preset, []).agent).toBeUndefined();
  });
});

it('duplicates configuration without approval, schedule or run state and preserves exact phases', () => {
  const original = {
    id: 'old',
    name: 'Measured GET',
    target: 'http://127.0.0.1:8080/path?q=1',
    probeUrl: 'http://127.0.0.1:8080/probe',
    vector: 'http-get',
    agent: 'builtin',
    status: 'COMPLETED' as const,
    createdBy: 'owner',
    approvedBy: 'owner',
    runId: 'old-run',
    maxRps: 3,
    concurrency: 2,
    maxDurationSec: 20,
    scheduledAt: '2030-01-01',
    scenario: [
      { maxRps: 1, durationSec: 7 },
      { maxRps: 3, durationSec: 13 },
    ],
    endpoints: [{ method: 'POST', url: 'http://127.0.0.1:8080/business', body: 'a=1', weight: 2 }],
    dataset: [{ value: 'with,comma' }],
    headers: { 'X-Test': 'retained' },
  };
  const seed = duplicateCampaignSeed(original);
  expect(seed.target).toBe(original.target);
  expect(seed.probeUrl).toBe(original.probeUrl);
  expect(seed.copiedScenario).toEqual(original.scenario);
  expect(seed.copiedScenario).not.toBe(original.scenario);
  expect(parseEndpoints(seed.endpoints!)).toEqual(original.endpoints);
  expect(parseDataset(seed.dataset!)).toEqual(original.dataset);
  expect(seed.copiedHeaders).toEqual(original.headers);
  for (const field of ['id', 'status', 'approvedBy', 'runId', 'scheduledAt', 'recurrenceMin'])
    expect(seed).not.toHaveProperty(field);
});
