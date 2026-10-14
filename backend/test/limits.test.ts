import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import {
  HARD_CAPS,
  MAX_ENDPOINTS,
  MAX_USER_AGENTS,
  MAX_FLOW_STEPS,
  MAX_THINK_MS,
  MAX_DATASET_ROWS,
} from '../src/config/limits.js';
import { HARD_CAPS as HARD_CAPS_MODEL } from '../src/modules/campaigns/model.js';
import {
  MAX_ENDPOINTS as MAX_ENDPOINTS_ENGINE,
  MAX_USER_AGENTS as MAX_USER_AGENTS_ENGINE,
  MAX_FLOW_STEPS as MAX_FLOW_STEPS_ENGINE,
  MAX_THINK_MS as MAX_THINK_MS_ENGINE,
  MAX_DATASET_ROWS as MAX_DATASET_ROWS_ENGINE,
} from '../src/engine/types.js';

// These tests lock down the "single source of truth" for the safety caps:
// config/limits.ts is the only place they are defined, everything else
// re-exports it, and /health hands the exact same object to the frontend.
// If someone reintroduces a divergent copy, one of these fails.

describe('caps are centralized in config/limits.ts', () => {
  it('HARD_CAPS holds the expected safety envelope and is frozen', () => {
    expect(HARD_CAPS).toEqual({ maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 });
    expect(Object.isFrozen(HARD_CAPS)).toBe(true);
    // Frozen: an attempt to widen a cap at runtime is a no-op (throws in strict).
    expect(() => {
      (HARD_CAPS as unknown as { maxRps: number }).maxRps = 999_999;
    }).toThrow();
    expect(HARD_CAPS.maxRps).toBe(2000);
  });

  it('the campaign model re-exports the very same HARD_CAPS object (no copy)', () => {
    expect(HARD_CAPS_MODEL).toBe(HARD_CAPS);
  });

  it('the engine re-exports the very same run-shape bounds (no copy)', () => {
    expect(MAX_ENDPOINTS_ENGINE).toBe(MAX_ENDPOINTS);
    expect(MAX_USER_AGENTS_ENGINE).toBe(MAX_USER_AGENTS);
    expect(MAX_FLOW_STEPS_ENGINE).toBe(MAX_FLOW_STEPS);
    expect(MAX_THINK_MS_ENGINE).toBe(MAX_THINK_MS);
    expect(MAX_DATASET_ROWS_ENGINE).toBe(MAX_DATASET_ROWS);
  });

  it('/health exposes the immutable ceiling and the effective caps (ceiling when unset)', async () => {
    const { app } = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
      allowedTargets: ['127.0.0.1'],
      logger: false,
      serveStatic: false,
    });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    // The absolute ceiling is always the frozen HARD_CAPS.
    expect(r.json().hardCapsCeiling).toEqual({ ...HARD_CAPS });
    // No CISO limit set yet → effective caps default to the ceiling.
    expect(r.json().hardCaps).toEqual({ ...HARD_CAPS });
  });
});
