import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';

// Loopback refuses instantly → recon degrades to an empty surface without a slow
// external request (runRecon only throws for an OFF-allowlist host, which 127.0.0.1
// is not here). We assert the endpoint CONTRACT, not live recon findings.
const allowed = ['127.0.0.1'];
const TARGET = 'http://127.0.0.1/';

describe('GET /api/recon — opt-in ?actions=1 (P7)', () => {
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

  it('omits `actions` by default (byte-identical recon contract)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/recon?target=${encodeURIComponent(TARGET)}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('actions');
    expect(body).toHaveProperty('profile');
    expect(body).toHaveProperty('suggestedPaths');
  });

  it('returns the ranked action set when actions=1', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/recon?target=${encodeURIComponent(TARGET)}&actions=1`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { actions?: { id: string; applicable: boolean; relevance: number }[] };
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions!.length).toBeGreaterThan(0);
    // The synthesized baseline is always present.
    expect(body.actions!.some((a) => a.id === 'baseline')).toBe(true);
    // Ranked descending by relevance.
    const rels = body.actions!.map((a) => a.relevance);
    expect([...rels].sort((x, y) => y - x)).toEqual(rels);
  });

  it('still 400s without a target', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/recon?actions=1' });
    expect(r.statusCode).toBe(400);
  });
});
