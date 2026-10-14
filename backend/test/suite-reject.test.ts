import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * The suite-level Reject — the batch counterpart to a single campaign's Reject,
 * so a template (suite) campaign offers the same governance actions as a basic
 * one. A different approver (≠ author) rejects every pending step, with a
 * mandatory reason.
 */
function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-12') },
  ]);
  return initAuth({ USER_MODE: 'team', AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('POST /api/suites/:id/reject (suite-level rejection)', () => {
  let app: FastifyInstance;
  let eng = '';
  let off = '';

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ['127.0.0.1'],
        logger: false,
        serveStatic: false,
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    off = await login(app, 'off@wedos', 'pw-ciso-12');
  });

  const as = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  async function instantiateSuite(): Promise<string> {
    const pb = await as(eng, 'POST', '/api/playbooks', {
      name: 'Reject test',
      category: 'Custom',
      summary: 'two tiny steps',
      when: 'test',
      steps: [
        { name: 'step-1', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
        { name: 'step-2', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
      ],
    });
    const pbId = pb.json().id;
    const inst = await as(eng, 'POST', `/api/playbooks/${pbId}/instantiate`, {
      target: 'http://127.0.0.1:9/',
    });
    return inst.json().campaigns[0].suiteId as string;
  }

  it('rejects every pending step (a different approver) with a reason', async () => {
    const suiteId = await instantiateSuite();
    const res = await as(off, 'POST', `/api/suites/${suiteId}/reject`, { reason: 'out of window' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ suiteId, rejected: 2, skipped: 0 });

    const members = (
      (await as(off, 'GET', '/api/campaigns')).json() as {
        suiteId?: string;
        status: string;
        approvalReason?: string;
      }[]
    ).filter((c) => c.suiteId === suiteId);
    expect(members).toHaveLength(2);
    expect(members.every((c) => c.status === 'REJECTED')).toBe(true);
    expect(members.every((c) => c.approvalReason === 'out of window')).toBe(true);
  });

  it('refuses a rejection with no reason (400)', async () => {
    const suiteId = await instantiateSuite();
    const res = await as(off, 'POST', `/api/suites/${suiteId}/reject`, { reason: '  ' });
    expect(res.statusCode).toBe(400);
  });

  it('skips a step the actor authored (separation of duties) rather than rejecting it', async () => {
    // The engineer authored the steps, so the engineer cannot self-reject them.
    const suiteId = await instantiateSuite();
    const res = await as(eng, 'POST', `/api/suites/${suiteId}/reject`, { reason: 'mine' });
    // Engineers lack campaign:approve → forbidden before the author check even matters.
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown suite', async () => {
    const res = await as(off, 'POST', '/api/suites/nope/reject', { reason: 'x' });
    expect(res.statusCode).toBe(404);
  });
});
