import { describe, expect, it } from 'vitest';
import { presetSeed } from './campaign-form.js';
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
