import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * When the recovery gate finds the target unreachable across repeated waves, the
 * sequencer auto-pauses the whole suite (rather than grinding through skips or
 * risking relaunching load onto a downed origin). The target here (127.0.0.1
 * with nothing listening) is down for the whole run.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-12') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}
const login = async (app: FastifyInstance, email: string, pw: string): Promise<string> =>
  (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;

describe('suite auto-pause on a down origin', () => {
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
        // Gate ENABLED but fast, so each unreachable check fails quickly.
        suiteRecovery: { needed: 1, intervalMs: 20, maxWaitMs: 250, requestTimeoutMs: 120 },
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    off = await login(app, 'off@wedos', 'pw-ciso-12');
  });

  const as = (t: string, m: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method: m, url, headers: { authorization: `Bearer ${t}` }, payload });

  it('auto-pauses after repeated gate-skips against an unreachable target', async () => {
    // Four tiny steps: step 0 runs, then the gate before steps 1 and 2 fails
    // (target down) → 2 consecutive skips → auto-pause, and step 3 remains so the
    // pause gate actually holds the sequence (visible in the live state).
    const pb = await as(eng, 'POST', '/api/playbooks', {
      name: 'Down suite',
      category: 'Custom',
      summary: 'four tiny steps',
      when: 'test',
      steps: [0, 1, 2, 3].map((i) => ({
        name: `step-${i}`,
        maxRps: 5,
        concurrency: 2,
        maxDurationSec: 1,
        profile: 'constant',
      })),
    });
    const inst = await as(eng, 'POST', `/api/playbooks/${pb.json().id}/instantiate`, {
      target: 'http://127.0.0.1:1/',
    });
    const suiteId = inst.json().campaigns[0].suiteId as string;

    // Two-step: the CISO approves, then the engineer runs.
    await as(off, 'POST', `/api/suites/${suiteId}/approve`);
    expect((await as(eng, 'POST', `/api/suites/${suiteId}/run`)).statusCode).toBe(202);

    // Poll the live sequence state until it reports auto-paused.
    let autoPaused = false;
    for (let i = 0; i < 40 && !autoPaused; i++) {
      const seqs = (await as(off, 'GET', '/api/suites/sequences')).json() as {
        sequences: Record<string, { autoPaused?: boolean; paused: boolean }>;
      };
      autoPaused = seqs.sequences[suiteId]?.autoPaused === true;
      if (!autoPaused) await sleep(200);
    }
    expect(autoPaused).toBe(true);

    // It is audited as a pause with the auto-pause reason.
    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('auto-paused');

    // Not every step ran — the sequence stopped instead of grinding all skips.
    const list = (await as(off, 'GET', '/api/campaigns')).json() as {
      suiteId?: string;
      status: string;
    }[];
    const members = list.filter((c) => c.suiteId === suiteId);
    expect(members.filter((c) => c.status === 'COMPLETED').length).toBeLessThan(3);

    await as(off, 'POST', `/api/suites/${suiteId}/cancel`); // clean up the held sequence
  }, 40000);
});
