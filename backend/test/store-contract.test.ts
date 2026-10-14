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
 * set (e.g. a disposable local cluster); it is mandatory in the PostgreSQL CI job.
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
      const quality = {
        measuredSamples: 2,
        totalSamples: 2,
        eventLoopMeasuredSamples: 2,
        peakEventLoopDelayMs: 20,
        peakRecentEventLoopDelayMs: null,
        peakThrottledFraction: 0,
      };
      r.baseline = { samples: 2, availabilityPct: 100, latencyMs: { p50: 10, p95: 20 }, quality };
      r.recoveryBeforeRun = {
        available: true,
        verified: true,
        waitedMs: 1250,
        checks: 2,
        quality,
        observation: { vantage: 'remote', receivedSamples: 2, missingSamples: 0, complete: true },
      };
      await store.saveRun(r);
      const stored = await store.getRun(r.runId);
      expect(stored?.campaignId).toBe(c.id);
      expect(stored?.baseline?.quality).toEqual(quality);
      expect(stored?.recoveryBeforeRun).toEqual(r.recoveryBeforeRun);
      expect((await store.listRuns(c.id)).map((x) => x.runId)).toContain(r.runId);
    });

    it('a malformed (non-UUID) id is "not found", never an error', async () => {
      // The postgres keys are `uuid`; a bogus path param must not surface as a 500.
      expect(await store.getCampaign('not-a-uuid')).toBeUndefined();
      expect(await store.getRun('nonexistent')).toBeUndefined();
      expect(await store.listRuns('bogus')).toEqual([]);
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

    it('lists newly recorded runs first and preserves order when updating an older run', async () => {
      const c = makeCampaign();
      await store.saveCampaign(c);
      const older = makeRun(c.id);
      const newer = makeRun(c.id);
      await store.saveRun(older);
      await store.saveRun(newer);
      await store.saveRun(older);
      expect((await store.listRuns(c.id)).map((run) => run.runId)).toEqual([
        newer.runId,
        older.runId,
      ]);
    });

    it('healthy() and pruneOldData()', async () => {
      expect(await store.healthy()).toBe(true);
      const removed = await store.pruneOldData(365);
      expect(removed).toEqual(
        expect.objectContaining({ runs: expect.any(Number), audit: expect.any(Number) }),
      );
    });
    it('persists fleet inventory and rolls it back transactionally', async () => {
      const device = {
        id: randomUUID(),
        agentId: 'contract-' + randomUUID(),
        name: 'Sensor',
        group: 'Lab',
        profile: 'sensor' as const,
        privateIp: '10.0.0.10',
        notes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        credential: { hash: 'a'.repeat(64), expiresAt: Date.now() + 86400_000 },
        heartbeat: {
          sequence: 1,
          receivedAt: Date.now(),
          version: 'contract/v1',
          uptimeSec: 1,
          peerIp: '127.0.0.1',
        },
      };
      await store.saveFleetDevice(device);
      expect((await store.listFleetDevices()).find((d) => d.id === device.id)).toEqual(device);
      await expect(
        store.transaction(async (tx) => {
          await tx.deleteFleetDevice(device.id);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await store.listFleetDevices()).some((d) => d.id === device.id)).toBe(true);
      await store.deleteFleetDevice(device.id);
      expect((await store.listFleetDevices()).some((d) => d.id === device.id)).toBe(false);
    });
  });
}

const pgUrl = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !pgUrl) {
  throw new Error('DATABASE_URL_TEST is required for the PostgreSQL gate');
}
contract('memory', () => new MemoryStore(), false);
contract('postgres', () => new PostgresStore(pgUrl ?? ''), !pgUrl);
