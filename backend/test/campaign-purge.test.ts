import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';
import { kills } from '../src/runtime/kills.js';
import { KillSwitch } from '../src/modules/probe/probe.js';
import type { Campaign } from '../src/modules/campaigns/model.js';

/**
 * Admin campaign purge: officer-only, deletes test campaigns + their runs, never
 * deletes a RUNNING campaign (its engine is live) and never touches the audit log.
 */
const USERS = JSON.stringify([
  { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('offpw') },
  { email: 'eng@wedos', role: 'engineer', passwordHash: hashPassword('engpw') },
]);

function camp(status: string): Campaign {
  return {
    id: `c-${status}`,
    name: `c-${status}`,
    status,
    target: 'https://bank.cz/',
    createdBy: 'e',
    createdAt: new Date().toISOString(),
  } as unknown as Campaign;
}

describe('admin campaign purge', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  const token = async (email: string, password: string): Promise<string> =>
    (
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
    ).json().token as string;
  const purge = async (t: string, scope: string) =>
    app.inject({
      method: 'POST',
      url: '/api/campaigns/purge',
      headers: { authorization: `Bearer ${t}` },
      payload: { scope },
    });

  beforeEach(async () => {
    store = new MemoryStore();
    const built = await buildApp({
      store,
      auth: initAuth({ AUTH_JWT_SECRET: 'sek', AUTH_USERS: USERS } as NodeJS.ProcessEnv),
      allowedTargets: ['bank.cz'],
      logger: false,
      serveStatic: false,
    });
    app = built.app;
    for (const s of ['COMPLETED', 'KILLED_AUTO', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING']) {
      await store.saveCampaign(camp(s));
    }
  });

  it('settled scope removes only terminal campaigns', async () => {
    const r = await purge(await token('off@wedos', 'offpw'), 'settled');
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe(2); // COMPLETED + KILLED_AUTO
    const left = (await store.listCampaigns()).map((c) => c.status).sort();
    expect(left).toEqual(['APPROVED', 'PENDING_APPROVAL', 'RUNNING']);
  });

  it('all scope removes pending/approved and kill-switches (not deletes) running', async () => {
    const ks = new KillSwitch();
    kills.set('c-RUNNING', ks);
    const r = await purge(await token('off@wedos', 'offpw'), 'all');
    expect(r.json().deleted).toBe(4); // terminal + pending + approved
    expect(r.json().killedRunning).toBe(1);
    expect(ks.killed).toBe(true); // the running engine was signalled to stop
    // The running campaign is kept (its engine is live) — re-purge once it settles.
    expect((await store.listCampaigns()).map((c) => c.status)).toEqual(['RUNNING']);
  });

  it('is officer-gated (an engineer is forbidden)', async () => {
    const r = await purge(await token('eng@wedos', 'engpw'), 'all');
    expect(r.statusCode).toBe(403);
    expect(await store.listCampaigns()).toHaveLength(5); // nothing deleted
  });

  it('writes a campaign.purge audit entry', async () => {
    await purge(await token('off@wedos', 'offpw'), 'settled');
    const chain = await store.listAuditChain();
    expect(chain.some((e) => e.action === 'campaign.purge')).toBe(true);
  });
});
