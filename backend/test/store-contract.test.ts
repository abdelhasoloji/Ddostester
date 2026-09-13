import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import type { Store } from '../src/store/types.js';
import type { User } from '../src/auth/users.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
import { verifyChain } from '../src/modules/audit/integrity.js';

/**
 * One contract, run against every Store implementation, so memory and postgres
 * behave identically. The postgres suite runs only when DATABASE_URL_TEST is
 * set (e.g. a disposable local cluster); it is skipped in CI otherwise.
 */

function makeCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: randomUUID(),
    name: 'contract',
    target: 'http://localhost/',
    probeUrl: 'http://localhost/',
    vector: 'http-get',
    maxRps: 10,
    concurrency: 2,
    maxDurationSec: 10,
    createdBy: 'e@wedos',
    authorized: true,
    status: 'PENDING_APPROVAL',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function makeRun(campaignId: string): CampaignRun {
  return {
    runId: randomUUID(),
    campaignId,
    status: 'COMPLETED',
    generator: {
      id: randomUUID(),
      config: {
        url: 'http://localhost/',
        concurrency: 1,
        durationSec: 1,
        maxRps: 1,
        authorized: true,
      },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalRequests: 1,
      successful: 1,
      failed: 0,
      statusCounts: { '2xx': 1 },
      latencyMs: { min: 1, max: 1, mean: 1, p50: 1, p95: 1, p99: 1 },
      actualRps: 1,
      errors: {},
    },
    probe: {
      samples: 1,
      available: 1,
      errorRate5xx: 0,
      latencyMs: { p50: 1, p95: 1, p99: 1 },
      successful: 1,
    },
    wrs: {
      detection: 90,
      mitigation: 90,
      availability: 100,
      collateral: 100,
      wrs: 95,
      level: 'A+',
    },
  } as unknown as CampaignRun;
}

function contract(name: string, makeStore: () => Store, skip: boolean): void {
  const d = skip ? describe.skip : describe;
  d(`store contract: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = makeStore();
      await store.init();
    });
    afterAll(async () => {
      await store?.close();
    });

    it('campaign round-trip', async () => {
      const c = makeCampaign();
      await store.saveCampaign(c);
      expect((await store.getCampaign(c.id))?.name).toBe('contract');
      expect((await store.listCampaigns()).some((x) => x.id === c.id)).toBe(true);
    });

    it('run round-trips against its campaign', async () => {
      const c = makeCampaign();
      await store.saveCampaign(c);
      const r = makeRun(c.id);
      await store.saveRun(r);
      expect((await store.getRun(r.runId))?.campaignId).toBe(c.id);
      expect((await store.listRuns(c.id)).map((x) => x.runId)).toContain(r.runId);
    });

    it('audit append + list', async () => {
      await store.saveAudit({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: 'a@wedos',
        action: 'campaign.create',
      });
      expect((await store.listAudit(10)).length).toBeGreaterThan(0);
    });

    it('audit entries are hash-chained and verify end to end', async () => {
      for (const actor of ['a@wedos', 'b@wedos', 'c@wedos']) {
        await store.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'campaign.execute',
        });
      }
      const chain = await store.listAuditChain();
      expect(chain.length).toBeGreaterThanOrEqual(3);
      // Every entry carries its chain fields and the whole chain verifies.
      expect(chain.every((e) => e.hash && e.prevHash)).toBe(true);
      expect(verifyChain(chain).ok).toBe(true);
      // Tampering a persisted field is detected on re-verify.
      const tampered = chain.map((e, i) => (i === 1 ? { ...e, actor: 'evil@wedos' } : e));
      expect(verifyChain(tampered).ok).toBe(false);
    });

    it('users CRUD', async () => {
      const email = `u-${randomUUID()}@wedos`;
      await store.saveUser({ email, role: 'viewer', passwordHash: 'h' });
      expect((await store.getUser(email))?.role).toBe('viewer');
      await store.deleteUser(email);
      expect(await store.getUser(email)).toBeUndefined();
    });

    it('canonicalises a legacy `officer` role to `admin` on read (never dropped)', async () => {
      const email = `legacy-${randomUUID()}@wedos`;
      // A user provisioned before the roles overhaul is stored as `officer`.
      await store.saveUser({
        email,
        role: 'officer' as unknown as User['role'],
        passwordHash: 'h',
      });
      // getUser must return them, canonicalised to `admin` — not undefined
      // (the pre-fix `isRole` filter locked them out at the persistence layer).
      expect((await store.getUser(email))?.role).toBe('admin');
      // …and they stay visible in listUsers, also canonicalised.
      const listed = (await store.listUsers()).find((u) => u.email === email);
      expect(listed?.role).toBe('admin');
      await store.deleteUser(email);
    });

    it('playbooks CRUD', async () => {
      const id = `custom-${randomUUID()}`;
      await store.savePlaybook({
        id,
        name: 'p',
        category: 'C',
        summary: '',
        when: '',
        steps: [
          {
            name: 's',
            summary: '',
            maxRps: 1,
            concurrency: 1,
            maxDurationSec: 1,
            profile: 'constant',
          },
        ],
        custom: true,
      });
      expect((await store.getPlaybook(id))?.name).toBe('p');
      await store.deletePlaybook(id);
      expect(await store.getPlaybook(id)).toBeUndefined();
    });

    it('healthy() and pruneOldData()', async () => {
      expect(await store.healthy()).toBe(true);
      const removed = await store.pruneOldData(365);
      expect(removed).toEqual(
        expect.objectContaining({ runs: expect.any(Number), audit: expect.any(Number) }),
      );
    });
  });
}

const pgUrl = process.env.DATABASE_URL_TEST;
contract('memory', () => new MemoryStore(), false);
contract('postgres', () => new PostgresStore(pgUrl ?? ''), !pgUrl);
