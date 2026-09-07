import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const ALLOWED = ['127.0.0.1', 'localhost'];
const LAB = ['lab-target.internal'];
const RUNNER_TOKEN = 'runner-secret-token';

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-1234') },
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw-officer-123') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

const validVerdict = {
  schema: 'shieldtest.lab.verdict/v1',
  class: 'C',
  kind: 'udp-amplification',
  scenario: 'amplification-ramp',
  labTarget: 'lab-target.internal',
  amplificationFactor: 20,
  packetAmplification: 2,
  requests: 200,
  target: { packets: 400, avgPps: 50, avgBps: 8000 },
  mitigation: null,
  outcome: 'UNMITIGATED_BASELINE',
  source: 'shieldtest-lab',
  generatedAt: new Date().toISOString(),
};

describe('Network bench — governed record-and-dispatch', () => {
  let app: FastifyInstance;
  let ciso = '';
  let officer = '';

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        labTargets: LAB,
        benchRunnerToken: RUNNER_TOKEN,
        logger: false,
        serveStatic: false,
      })
    ).app;
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-1234');
    officer = await login(app, 'off@wedos', 'pw-officer-123');
  });

  const asCiso = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${ciso}` }, payload });
  const asRunner = (url: string, payload: object, token = RUNNER_TOKEN) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });

  it('exposes the scenario catalogue to the CISO, not the officer', async () => {
    const ok = await asCiso('GET', '/api/bench/scenarios');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().scenarios.length).toBeGreaterThanOrEqual(11);
    expect(ok.json().dispatchEnabled).toBe(true);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/bench/scenarios',
      headers: { authorization: `Bearer ${officer}` },
    });
    expect(denied.statusCode).toBe(403); // officer has no bench:read
  });

  it('runs the full governed loop: request → claim → verdict → recorded', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'amplification-ramp' });
    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run).toMatchObject({
      status: 'REQUESTED',
      scenario: 'amplification-ramp',
      labTarget: 'lab-target.internal',
    });

    // Isolated runner claims the oldest REQUESTED run.
    const claimed = await asRunner('/api/bench/runs/next/claim', { runner: 'lab-runner-1' });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      id: run.id,
      status: 'CLAIMED',
      claimedBy: 'lab-runner-1',
    });

    // Runner posts the class-C verdict back.
    const done = await asRunner(`/api/bench/runs/${run.id}/result`, { verdict: validVerdict });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'COMPLETED' });
    expect(done.json().verdict.amplificationFactor).toBe(20);

    // The CISO sees the completed run + verdict.
    const listed = await asCiso('GET', '/api/bench/runs');
    const found = listed.json().runs.find((r: { id: string }) => r.id === run.id);
    expect(found.status).toBe('COMPLETED');
    expect(found.verdict.outcome).toBe('UNMITIGATED_BASELINE');

    // Both the request and the verdict are in the audit trail.
    const audit = await asCiso('GET', '/api/audit');
    const dump = JSON.stringify(audit.json());
    expect(dump).toContain('bench.request');
    expect(dump).toContain('bench.verdict');
  });

  it('rejects an unknown scenario and a non-lab target', async () => {
    expect((await asCiso('POST', '/api/bench/runs', { scenario: 'nope' })).statusCode).toBe(400);
    expect(
      (
        await asCiso('POST', '/api/bench/runs', {
          scenario: 'amplification-ramp',
          labTarget: '127.0.0.1',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('dispatch is CISO-only (officer 403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bench/runs',
      headers: { authorization: `Bearer ${officer}` },
      payload: { scenario: 'amplification-ramp' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('the runner API requires the runner token', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/bench/runs/next/claim', payload: {} }))
        .statusCode,
    ).toBe(401);
    expect((await asRunner('/api/bench/runs/next/claim', {}, 'wrong-token')).statusCode).toBe(401);
  });

  it('rejects a verdict that is not class C', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'wave-detection' });
    const run = created.json();
    await asRunner('/api/bench/runs/next/claim', { runner: 'r' });
    // Claim may return a different oldest run; claim until we get this one is
    // overkill — just post against this id directly (it was claimed above or is
    // still REQUESTED; the endpoint validates the verdict regardless of state).
    const bad = await asRunner(`/api/bench/runs/${run.id}/result`, {
      verdict: { ...validVerdict, class: 'B', scenario: 'wave-detection' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/class/i);
  });

  it('dispatch fails closed without a runner token', async () => {
    const app2 = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        labTargets: LAB,
        // no benchRunnerToken
        logger: false,
        serveStatic: false,
      })
    ).app;
    const token = await login(app2, 'ciso@wedos', 'pw-ciso-1234');
    const r = await app2.inject({
      method: 'POST',
      url: '/api/bench/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: { scenario: 'amplification-ramp' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/disabled/i);
  });
});
