import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { PLAYBOOKS, isBaselineStep } from '../src/modules/playbooks/playbooks.js';
import { MAX_COMPOSITE_STEPS } from '../src/config/limits.js';

// A local, fail-fast target: instantiation now runs a best-effort recon on the
// target, so a real host would make (slow, flaky) external requests from CI. A
// loopback address refuses instantly → recon falls back to template paths.
const allowed = ['127.0.0.1'];
const TARGET = 'http://127.0.0.1/';

// Two distinct curated templates to compose.
const twoPbs = PLAYBOOKS.slice(0, 2);
const twoIds = twoPbs.map((p) => p.id);
// Steps concatenated, minus the deduped baselines (one baseline kept per suite).
const rawSteps = twoPbs.reduce((n, p) => n + p.steps.length, 0);
const twoBaselines = twoPbs.reduce((n, p) => n + p.steps.filter(isBaselineStep).length, 0);
const twoSteps = rawSteps - Math.max(0, twoBaselines - 1);

describe('POST /api/suites/compose', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  it('composes several templates into one suite of pending campaigns', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/suites/compose',
      payload: { playbookIds: twoIds, name: 'Composite mix', target: TARGET },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { suiteId: string; campaigns: { suiteId: string; status: string }[] };
    expect(body.campaigns.length).toBe(twoSteps);
    // All campaigns share the one suiteId and start un-approved.
    expect(new Set(body.campaigns.map((c) => c.suiteId))).toEqual(new Set([body.suiteId]));
    expect(body.campaigns.every((c) => c.status === 'PENDING_APPROVAL')).toBe(true);
  });

  it('rejects fewer than two templates', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/suites/compose',
      payload: { playbookIds: [twoIds[0]], target: TARGET },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/at least two/);
  });

  it('rejects an unknown template id', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/suites/compose',
      payload: { playbookIds: [twoIds[0], 'does-not-exist'], target: TARGET },
    });
    expect(r.statusCode).toBe(404);
  });

  it('rejects a target that is not on the allowlist', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/suites/compose',
      payload: { playbookIds: twoIds, target: 'https://evil.example.com/' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects a composition over the total-step cap', async () => {
    // Repeat a real multi-step template enough times to exceed the cap. The
    // endpoint looks each id up independently, so duplicates are valid input.
    const big = PLAYBOOKS.filter((p) => p.steps.length > 1).sort(
      (a, b) => b.steps.length - a.steps.length,
    )[0];
    const copies = Math.ceil((MAX_COMPOSITE_STEPS + 1) / big.steps.length);
    const r = await app.inject({
      method: 'POST',
      url: '/api/suites/compose',
      payload: { playbookIds: Array(copies).fill(big.id), target: TARGET },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/maximum is/);
  });
});
