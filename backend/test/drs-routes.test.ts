import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { defaultPlan } from '../src/modules/drs/workflow.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
const fixture: Campaign = {
  id: randomUUID(),
  name: 'DRS fixture',
  createdBy: 'fixture',
  createdAt: new Date().toISOString(),
  status: 'PENDING_APPROVAL',
  authorized: true,
  target: 'http://127.0.0.1/',
  probeUrl: 'http://127.0.0.1/',
  agent: 'fleet',
  drsProfileId: 'drs-3.00.00-151002',
  fleetDeviceIds: ['one'],
  vector: 'http-get',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
};
it('persists revisions, simulation evidence and final reports without invoking a generator or granting physical campaign approval', async () => {
  const store = new MemoryStore();
  await store.saveCampaign(fixture);
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { app } = await buildApp({
    store,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
  });
  const url = '/api/campaigns/' + fixture.id + '/drs/';
  try {
    expect((await app.inject({ url: '/api/drs/reference' })).json().manifest.vector_count).toBe(
      131,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + 'revisions',
          payload: { plan: defaultPlan(fixture, 'engine-validation') },
        })
      ).statusCode,
    ).toBe(200);
    let c = (await store.getCampaign(fixture.id))!;
    let revision = c.drsDocument!.revisions[0];
    const body = { revisionId: revision.id };
    expect(
      (await app.inject({ method: 'POST', url: url + 'freeze', payload: { revisionId: 'stale' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: url + 'freeze', payload: body })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: url + 'simulate', payload: body })).statusCode,
    ).toBe(400);
    const simulation = await app.inject({
      method: 'POST',
      url: url + 'simulate',
      payload: { ...body, confirmed: true, fixture: 'healthy' },
    });
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json().result.score).toBe(1);
    expect(
      (await app.inject({ method: 'POST', url: url + 'finalize', payload: body })).statusCode,
    ).toBe(200);
    const report = await app.inject({ url: url + 'report.json?revision=1' });
    expect(report.statusCode).toBe(200);
    expect(report.json().proofs).toHaveLength(2);
    expect((await app.inject({ url: url + 'report.html?revision=1' })).body).toContain(
      'Simulation score',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + 'evidence',
          payload: { ...body, evidence: report.json().proofs[0].data },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + 'revisions',
          payload: { plan: defaultPlan(fixture, 'measured') },
        })
      ).statusCode,
    ).toBe(200);
    c = (await store.getCampaign(fixture.id))!;
    revision = c.drsDocument!.revisions[1];
    expect(c.status).toBe('COMPLETED');
    expect(c.approvedBy).toBeUndefined();
    expect(c.drsDocument?.revisions[0].proofs).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + 'freeze',
          payload: { revisionId: revision.id },
        })
      ).statusCode,
    ).toBe(200);
    const final = await app.inject({
      method: 'POST',
      url: url + 'finalize',
      payload: { revisionId: revision.id },
    });
    expect(final.json().result.status).toBe('INDETERMINATE');
    expect(
      (await app.inject({ url: url + 'report.json?revision=1' })).json().assessment.score,
    ).toBe(1);
    expect((await store.listAudit()).filter((e) => e.action === 'drs.verdict').length).toBe(7);
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.listRuns()).toHaveLength(0);
  } finally {
    await app.close();
    vi.restoreAllMocks();
  }
});
it('refuses archive mutation and a caller-supplied evidence archive in generic creation', async () => {
  const store = new MemoryStore();
  await store.saveCampaign({ ...fixture, archived: true });
  const { app } = await buildApp({
    store,
    allowedTargets: ['127.0.0.1'],
    logger: false,
    serveStatic: false,
    auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/campaigns/' + fixture.id + '/drs/revisions',
          payload: { plan: defaultPlan(fixture, 'engine-validation') },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/campaigns',
          payload: { ...fixture, drsDocument: { currentRevision: 1, revisions: [] } },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it('creates a standalone software validation with no target attestation, Fleet or generator', async () => {
  const store = new MemoryStore();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { app } = await buildApp({
    store,
    allowedTargets: [],
    logger: false,
    serveStatic: false,
    auth: initAuth({ USER_MODE: 'team' } as NodeJS.ProcessEnv),
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/drs/validations',
      payload: { maxLevel: 2 },
    });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c.target).toBe('simulation://fixture');
    expect(c.authorized).toBe(false);
    expect(c.agent).toBe('simulation');
    const r = c.drsDocument.revisions[0];
    const prefix = '/api/campaigns/' + c.id + '/drs/';
    expect(
      (await app.inject({ method: 'POST', url: prefix + 'freeze', payload: { revisionId: r.id } }))
        .statusCode,
    ).toBe(200);
    const validation = await app.inject({
      method: 'POST',
      url: prefix + 'simulate',
      payload: { revisionId: r.id, fixture: 'healthy', confirmed: true },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().result.score).toBe(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix + 'finalize',
          payload: { revisionId: r.id },
        })
      ).statusCode,
    ).toBe(200);
    expect((await store.getCampaign(c.id))?.status).toBe('COMPLETED');
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.listRuns()).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/campaigns/' + c.id + '/execute',
          payload: { confirmed: true },
        })
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
    vi.restoreAllMocks();
  }
});
