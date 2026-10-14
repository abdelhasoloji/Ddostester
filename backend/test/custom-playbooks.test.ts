import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';

const allowed = ['127.0.0.1', 'localhost'];

describe('custom playbooks API', () => {
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

  it('lists curated playbooks (custom:false) by default', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/playbooks' });
    expect(r.statusCode).toBe(200);
    const list = r.json() as { id: string; custom: boolean }[];
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.every((p) => p.custom === false)).toBe(true);
  });

  it('creates a custom playbook, lists it, instantiates it, then deletes it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/playbooks',
      payload: {
        name: 'Nightly staging',
        category: 'Custom',
        steps: [
          { name: 'Warm', maxRps: 20, concurrency: 5, maxDurationSec: 20, profile: 'constant' },
          { name: 'Push', maxRps: 200, concurrency: 40, maxDurationSec: 60, profile: 'ramp' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(id.startsWith('custom-')).toBe(true);

    const list = (await app.inject({ method: 'GET', url: '/api/playbooks' })).json() as {
      id: string;
      custom: boolean;
    }[];
    expect(list.find((p) => p.id === id)?.custom).toBe(true);

    const inst = await app.inject({
      method: 'POST',
      url: `/api/playbooks/${id}/instantiate`,
      payload: { target: 'http://127.0.0.1/' },
    });
    expect(inst.statusCode).toBe(201);
    expect(inst.json().campaigns).toHaveLength(2);

    const del = await app.inject({ method: 'DELETE', url: `/api/playbooks/${id}` });
    expect(del.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/playbooks' })).json() as {
      id: string;
    }[];
    expect(after.find((p) => p.id === id)).toBeUndefined();
  });

  it('rejects an invalid custom playbook (400) and refuses to delete a curated one', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/playbooks', payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    const delCurated = await app.inject({ method: 'DELETE', url: '/api/playbooks/endurance' });
    expect(delCurated.statusCode).toBe(400);
  });
});
