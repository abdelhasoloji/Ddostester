import { it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
const input = {
  name: 'API synthetic',
  targetLevel: 1,
  intervalSec: 0,
  labTarget: '127.0.0.1',
  authorized: true,
};
it('keeps authentication/approval, immutable bindings, single admission and atomic duplicate verdict rejection', async () => {
  const store = new MemoryStore();
  const auth = initAuth({
    USER_MODE: 'team',
    AUTH_JWT_SECRET: 'local-test-only',
    AUTH_USERS: JSON.stringify([
      { email: 'author@fixture', role: 'admin', passwordHash: hashPassword('fixture-pass-author') },
      {
        email: 'reviewer@fixture',
        role: 'ciso',
        passwordHash: hashPassword('fixture-pass-reviewer'),
      },
      {
        email: 'viewer@fixture',
        role: 'viewer',
        passwordHash: hashPassword('fixture-pass-viewer'),
      },
    ]),
  });
  const { app } = await buildApp({
    store,
    auth,
    allowedTargets: ['localhost'],
    labTargets: ['127.0.0.1'],
    benchRunnerToken: 'fixture-runner',
    logger: false,
    serveStatic: false,
  });
  const login = async (email: string, password: string) =>
    (
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
    ).json().token;
  const author = await login('author@fixture', 'fixture-pass-author'),
    reviewer = await login('reviewer@fixture', 'fixture-pass-reviewer'),
    viewer = await login('viewer@fixture', 'fixture-pass-viewer');
  const request = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: 'Bearer ' + token },
    });
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/api/synthetic-campaigns', payload: input }))
        .statusCode,
    ).toBe(401);
    expect((await request(viewer, 'POST', '/api/synthetic-campaigns', input)).statusCode).toBe(403);
    const created = await request(author, 'POST', '/api/synthetic-campaigns', input);
    expect(created.statusCode).toBe(201);
    const c = created.json(),
      prefix = '/api/synthetic-campaigns/' + c.id;
    const launch = { confirmed: true, planHash: c.syntheticJourney.planHash };
    expect((await request(author, 'POST', prefix + '/start', launch)).statusCode).toBe(409);
    expect(
      (
        await request(reviewer, 'POST', '/api/campaigns/' + c.id + '/approval', {
          decision: 'APPROVED',
        })
      ).statusCode,
    ).toBe(200);
    expect((await request(reviewer, 'POST', prefix + '/start', launch)).statusCode).toBe(403);
    expect(
      (await request(author, 'POST', prefix + '/start', { ...launch, planHash: 'stale' }))
        .statusCode,
    ).toBe(409);
    expect((await request(author, 'POST', prefix + '/start', launch)).statusCode).toBe(200);
    expect(
      (await request(author, 'POST', '/api/bench/runs', { scenario: 'udp_maxpackets' })).statusCode,
    ).toBe(409);
    expect(
      (await request(author, 'POST', '/api/campaigns/' + c.id + '/drs/revisions', { plan: {} }))
        .statusCode,
    ).toBe(400);
    const claim = await request('fixture-runner', 'POST', '/api/bench/runs/next/claim', {
      runner: 'qa',
    });
    expect(claim.statusCode).toBe(200);
    const run = claim.json();
    const verdict = {
      schema: 'shieldtest.lab.verdict/v1',
      class: 'C',
      scenario: run.scenario,
      kind: 'tcp-connection-pressure',
      connections: {
        opened: 1,
        accepted: 1,
        refused: 0,
        concurrentPeak: 1,
        capacity: 200,
        saturationPct: 0,
      },
      outcome: 'UNMITIGATED_BASELINE',
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        request('fixture-runner', 'POST', '/api/bench/runs/' + run.id + '/result', { verdict }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await store.listBenchCoverage()).toHaveLength(1);
    await expect
      .poll(async () => (await store.getCampaign(c.id))?.status, { timeout: 5000 })
      .toBe('COMPLETED');
    const view = (await request(viewer, 'GET', prefix)).json();
    expect(view.campaign.status).toBe('COMPLETED');
    expect(view.campaign.syntheticJourney.state).toBe('COMPLETED');
    const report = (
      await request(viewer, 'GET', '/api/campaigns/' + c.id + '/drs/report.json')
    ).json();
    expect(report.attachments).toHaveLength(1);
    expect(report.assessment.score).toBeNull();
    expect(report.syntheticJourney.state).toBe('COMPLETED');
    expect(report.syntheticJourney.steps[0].runId).toBe(run.id);
    const html = await request(viewer, 'GET', '/api/campaigns/' + c.id + '/drs/report.html');
    expect(html.body).toContain('Synthetic execution');
    expect(html.body).toContain('COMPLETED');
    expect((await request(viewer, 'POST', prefix + '/stop', {})).statusCode).toBe(403);
    expect(
      (
        await request('fixture-runner', 'POST', '/api/bench/runs/' + run.id + '/result', {
          verdict,
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});
