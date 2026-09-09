import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const ALLOWED = ['127.0.0.1'];

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('pw-engineer-1') },
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw-officer-12') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL', 'REJECTED'];

describe('Multi-step suite sequencer', () => {
  let app: FastifyInstance;
  let eng = '';
  let off = '';

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        logger: false,
        serveStatic: false,
      })
    ).app;
    eng = await login(app, 'eng@wedos', 'pw-engineer-1');
    off = await login(app, 'off@wedos', 'pw-officer-12');
  });

  const as = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  it('runs every step of a suite in order, advancing to the next steps', async () => {
    // Engineer defines a tiny two-step playbook (1 s steps) and instantiates it.
    const pb = await as(eng, 'POST', '/api/playbooks', {
      name: 'Seq test',
      category: 'Custom',
      summary: 'two tiny steps',
      when: 'test',
      steps: [
        { name: 'step-1', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
        { name: 'step-2', maxRps: 5, concurrency: 2, maxDurationSec: 1, profile: 'constant' },
      ],
    });
    expect(pb.statusCode).toBe(201);
    const pbId = pb.json().id;

    const inst = await as(eng, 'POST', `/api/playbooks/${pbId}/instantiate`, {
      target: 'http://127.0.0.1/',
    });
    expect(inst.statusCode).toBe(201);
    const suiteId = inst.json().campaigns[0].suiteId as string;
    expect(inst.json().campaigns).toHaveLength(2);
    // Both start PENDING_APPROVAL, authored by the engineer.
    expect(
      inst.json().campaigns.every((c: { status: string }) => c.status === 'PENDING_APPROVAL'),
    ).toBe(true);

    // Officer (≠ author) runs the whole suite in one click.
    const run = await as(off, 'POST', `/api/suites/${suiteId}/run`);
    expect(run.statusCode).toBe(202);
    expect(run.json().steps).toBe(2);

    // Poll until both steps reach a terminal state (the sequencer approved + ran them).
    let members: { status: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const list = (await as(off, 'GET', '/api/campaigns')).json() as {
        suiteId?: string;
        status: string;
      }[];
      members = list.filter((c) => c.suiteId === suiteId);
      if (members.length === 2 && members.every((c) => TERMINAL.includes(c.status))) break;
      await sleep(500);
    }
    expect(members).toHaveLength(2);
    // The sequence advanced both steps past PENDING — the whole suite ran.
    expect(members.every((c) => TERMINAL.includes(c.status))).toBe(true);

    // The suite run is audited.
    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('suite.run');
  }, 40000);

  it('pause/resume/cancel return 404 when no sequence is running', async () => {
    for (const action of ['pause', 'resume', 'cancel']) {
      const r = await as(off, 'POST', `/api/suites/does-not-exist/${action}`);
      expect(r.statusCode).toBe(404);
    }
    // No sequences are in flight → empty map.
    const seq = await as(off, 'GET', '/api/suites/sequences');
    expect(seq.statusCode).toBe(200);
    expect(seq.json().sequences).toEqual({});
  });

  it('cancels a running sequence: kills the step in flight and leaves the rest unrun', async () => {
    // A 4-step playbook with longer steps, so there is time to cancel mid-flight.
    const pb = await as(eng, 'POST', '/api/playbooks', {
      name: 'Cancel test',
      category: 'Custom',
      summary: 'four steps',
      when: 'test',
      steps: [0, 1, 2, 3].map((i) => ({
        name: `step-${i}`,
        maxRps: 5,
        concurrency: 2,
        maxDurationSec: 3,
        profile: 'constant',
      })),
    });
    const pbId = pb.json().id;
    const inst = await as(eng, 'POST', `/api/playbooks/${pbId}/instantiate`, {
      target: 'http://127.0.0.1/',
    });
    const suiteId = inst.json().campaigns[0].suiteId as string;

    const run = await as(off, 'POST', `/api/suites/${suiteId}/run`);
    expect(run.statusCode).toBe(202);

    // Wait until the sequence is live (its control state is exposed).
    let live = false;
    for (let i = 0; i < 20 && !live; i++) {
      const seq = (await as(off, 'GET', '/api/suites/sequences')).json() as {
        sequences: Record<string, unknown>;
      };
      live = suiteId in seq.sequences;
      if (!live) await sleep(200);
    }
    expect(live).toBe(true);

    // Cancel it — the step in flight is killed, the sequence stops.
    const cancel = await as(off, 'POST', `/api/suites/${suiteId}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().cancelled).toBe(true);

    // The sequence winds down (its control state disappears).
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i++) {
      const seq = (await as(off, 'GET', '/api/suites/sequences')).json() as {
        sequences: Record<string, unknown>;
      };
      cleared = !(suiteId in seq.sequences);
      if (!cleared) await sleep(250);
    }
    expect(cleared).toBe(true);

    // Not every step ran: cancel stopped the sequence, so later steps stay
    // APPROVED (never executed).
    const list = (await as(off, 'GET', '/api/campaigns')).json() as {
      suiteId?: string;
      status: string;
    }[];
    const members = list.filter((c) => c.suiteId === suiteId);
    expect(members).toHaveLength(4);
    // Cancel stopped the sequence and closed it cleanly: later steps that never
    // ran are now CANCELLED (not left dangling), and not every step COMPLETED.
    expect(members.some((c) => c.status === 'CANCELLED')).toBe(true);
    expect(members.filter((c) => c.status === 'COMPLETED').length).toBeLessThan(4);

    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('suite.cancel');
  }, 40000);

  it('rejects a run for an unknown suite and requires approve permission', async () => {
    expect((await as(off, 'POST', '/api/suites/nope/run')).statusCode).toBe(404);
    // Engineer lacks campaign:approve.
    const denied = await as(eng, 'POST', '/api/suites/whatever/run');
    expect(denied.statusCode).toBe(403);
  });

  it('cancels a single unrun campaign, and refuses to cancel it twice', async () => {
    const created = await as(eng, 'POST', '/api/campaigns', {
      name: 'Cancel me',
      target: 'http://127.0.0.1/',
      probeUrl: 'http://127.0.0.1/',
      vector: 'http-get',
      maxRps: 5,
      concurrency: 2,
      maxDurationSec: 5,
      authorized: true,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const cancelled = await as(off, 'POST', `/api/campaigns/${id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('CANCELLED');

    // Already terminal → 400.
    const again = await as(off, 'POST', `/api/campaigns/${id}/cancel`);
    expect(again.statusCode).toBe(400);

    // Audited.
    const audit = JSON.stringify((await as(off, 'GET', '/api/audit')).json());
    expect(audit).toContain('campaign.cancel');
  });

  it('404s cancelling an unknown campaign', async () => {
    expect((await as(off, 'POST', '/api/campaigns/nope/cancel')).statusCode).toBe(404);
  });
});
