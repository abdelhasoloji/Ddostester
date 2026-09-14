import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

/**
 * End-to-end check of the between-wave availability gate: with a real (up)
 * target, the sequencer holds before the 2nd step until the target answers,
 * emits a `suite.gate` audit entry, and both steps run.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL', 'REJECTED'];

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'off@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-12') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

describe('suite recovery gate (between waves)', () => {
  let app: FastifyInstance;
  let srv: Server;
  let target = '';
  let eng = '';
  let off = '';

  beforeAll(async () => {
    srv = createServer((_q, r) => {
      r.statusCode = 200;
      r.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    target = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ['127.0.0.1'],
        logger: false,
        serveStatic: false,
        // Real, healthy target → tune the gate fast so the test is quick.
        suiteRecovery: { needed: 1, intervalMs: 20, maxWaitMs: 2000, requestTimeoutMs: 500 },
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    off = await login(app, 'off@wedos', 'pw-ciso-12');
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const as = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  it('gates before the 2nd step and audits suite.gate once the target answers', async () => {
    const pb = await as(eng, 'POST', '/api/playbooks', {
      name: 'Gate test',
      category: 'Custom',
      summary: 'two tiny steps',
      when: 'test',
      steps: [
        { name: 'step-1', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
        { name: 'step-2', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
      ],
    });
    const pbId = pb.json().id;
    const inst = await as(eng, 'POST', `/api/playbooks/${pbId}/instantiate`, { target });
    const suiteId = inst.json().campaigns[0].suiteId as string;

    // Two-step: the CISO approves, then the engineer runs.
    await as(off, 'POST', `/api/suites/${suiteId}/approve`);
    const run = await as(eng, 'POST', `/api/suites/${suiteId}/run`);
    expect(run.statusCode).toBe(202);

    let members: { status: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const list = (await as(off, 'GET', '/api/campaigns')).json() as {
        suiteId?: string;
        status: string;
      }[];
      members = list.filter((c) => c.suiteId === suiteId);
      if (members.length === 2 && members.every((c) => TERMINAL.includes(c.status))) break;
      await sleep(300);
    }
    expect(members).toHaveLength(2);
    expect(members.every((c) => TERMINAL.includes(c.status))).toBe(true);

    // The gate fired before the 2nd wave and recorded the target as available.
    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('suite.gate');
  }, 40000);
});
