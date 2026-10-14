import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';

const allowed = ['127.0.0.1'];
const action = (over: Record<string, unknown> = {}) => ({
  name: 'Action',
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 20,
  maxDurationSec: 30,
  createdBy: 'eng@wedos',
  authorized: true,
  ...over,
});

describe('POST /api/suites/from-actions (P7 compose tuned seeds)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const built = await buildApp({
      store: new MemoryStore(),
      auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
      allowedTargets: allowed,
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });

  const post = (payload: object): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: '/api/suites/from-actions', payload });

  it('a single action → one standalone pending campaign (no suiteId)', async () => {
    const r = await post({ campaigns: [action({ name: 'Solo' })] });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      suiteId?: string;
      campaigns: { status: string; suiteId?: string }[];
    };
    expect(body.suiteId).toBeUndefined();
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].status).toBe('PENDING_APPROVAL');
    expect(body.campaigns[0].suiteId).toBeUndefined();
  });

  it('several actions → one governed suite (shared suiteId, ordered, all pending)', async () => {
    const r = await post({
      name: 'Tuned mix',
      campaigns: [action({ name: 'A' }), action({ name: 'B' }), action({ name: 'C' })],
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as {
      suiteId: string;
      campaigns: { suiteId: string; suiteOrder: number; status: string; suiteName: string }[];
    };
    expect(body.suiteId).toBeTruthy();
    expect(new Set(body.campaigns.map((c) => c.suiteId))).toEqual(new Set([body.suiteId]));
    expect(body.campaigns.map((c) => c.suiteOrder)).toEqual([0, 1, 2]);
    expect(body.campaigns.every((c) => c.status === 'PENDING_APPROVAL')).toBe(true);
    expect(body.campaigns[0].suiteName).toBe('Tuned mix');
  });

  it('rejects an empty list', async () => {
    const r = await post({ campaigns: [] });
    expect(r.statusCode).toBe(400);
  });

  it('governance holds: an unauthorized or off-allowlist action is rejected', async () => {
    expect((await post({ campaigns: [action({ authorized: false })] })).statusCode).not.toBe(201);
    expect(
      (await post({ campaigns: [action({ target: 'https://evil.example/' })] })).statusCode,
    ).not.toBe(201);
  });
});
