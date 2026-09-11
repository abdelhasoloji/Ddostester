import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { kills } from '../src/runtime/kills.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

// Two resilience fixes on the kill path, both proven against the store + API:
//   1. runCampaign refuses a SECOND run for a campaign already in flight — a
//      duplicate start used to orphan the first engine loop (kill unreachable).
//   2. The kill endpoint force-reconciles a STALE RUNNING campaign (no live run
//      attached) instead of returning a dead 404 that forces a server restart.
function campaign(id: string, status: Campaign['status']): Campaign {
  return {
    id,
    name: id,
    status,
    target: 'http://127.0.0.1/',
    probeUrl: 'http://127.0.0.1/',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 2,
    maxDurationSec: 10,
    authorized: true,
    createdBy: 'eng',
    createdAt: new Date().toISOString(),
  } as Campaign;
}

describe('kill-switch resilience', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore();
    const built = await buildApp({
      store,
      auth: initAuth({} as NodeJS.ProcessEnv),
      allowedTargets: ['127.0.0.1', 'localhost'],
      logger: false,
      serveStatic: false,
    });
    app = built.app;
  });
  afterEach(() => {
    kills.clear('c1');
  });

  it('force-resets a stale RUNNING campaign via the kill endpoint (no live run)', async () => {
    // Stored RUNNING but nothing in the kill registry → a stale/zombie status.
    await store.saveCampaign(campaign('c1', 'RUNNING'));
    expect(kills.get('c1')).toBeUndefined();

    const r = await app.inject({ method: 'POST', url: '/api/campaigns/c1/kill' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'RESET_STALE' });

    // The campaign is no longer stuck RUNNING — it is re-runnable, with a note.
    const c = await store.getCampaign('c1');
    expect(c?.status).toBe('APPROVED');
    expect(c?.statusDetail).toMatch(/stale RUNNING/i);
  });

  it('still 404s a kill for a campaign that never ran', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/campaigns/ghost/kill' });
    expect(r.statusCode).toBe(404);
  });

  it('triggers the live kill switch when a run IS attached', async () => {
    await store.saveCampaign(campaign('c1', 'RUNNING'));
    const ks = new KillSwitch();
    kills.set('c1', ks);

    const r = await app.inject({ method: 'POST', url: '/api/campaigns/c1/kill' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'KILLED_MANUAL' });
    // The engine's abort signal is now raised.
    expect(ks.signal.aborted).toBe(true);
    expect(ks.reason).toBe('KILLED_MANUAL');
  });

  it('refuses to start a second run for a campaign already in flight', async () => {
    // APPROVED + a live kill switch in the registry simulates a run in flight.
    await store.saveCampaign(campaign('c1', 'APPROVED'));
    kills.set('c1', new KillSwitch());

    const r = await app.inject({ method: 'POST', url: '/api/campaigns/c1/execute' });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/already has a run in flight/i);
  });
});
