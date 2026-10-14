import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
  simulate,
  finalize,
} from '../src/modules/drs/workflow.js';
import { assessDrs } from '../src/modules/drs/scoring.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store/postgres.js';
import { auditedStore, mutationActor } from '../src/store/audited.js';

const url = process.env.DATABASE_URL_TEST;
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !url) {
  throw new Error('DATABASE_URL_TEST is required for the PostgreSQL gate');
}
const suite = url ? describe : describe.skip;
suite('PostgreSQL runtime and transaction guarantees', () => {
  let store: PostgresStore;
  it('persists immutable DRS revisions, failure history and evidence chains with transactional rollback', async () => {
    const c: Campaign = {
      id: randomUUID(),
      name: 'DRS persistence fixture',
      createdBy: 'fixture',
      createdAt: new Date().toISOString(),
      status: 'PENDING_APPROVAL',
      authorized: true,
      target: 'http://lab-target/',
      probeUrl: 'http://lab-target/',
      vector: 'http-get',
      agent: 'fleet',
      maxRps: 3,
      concurrency: 3,
      maxDurationSec: 20,
    };
    try {
      c.drsDocument = createRevision(undefined, defaultPlan(c, 'engine-validation'), 'fixture');
      const r = currentRevision(c.drsDocument);
      freeze(r, c);
      simulate(r, 'fixture', 'service-outage');
      finalize(r);
      c.drsDocument = createRevision(
        c.drsDocument,
        { ...r.plan, protectionConfiguration: 'New configuration' },
        'fixture',
      );
      await store.saveCampaign(c);
      const restored = (await store.getCampaign(c.id))!;
      expect(restored.drsDocument?.revisions).toHaveLength(2);
      expect(assessDrs(restored.drsDocument!.revisions[0]).terminalOutcome).toBe('FAIL');
      await expect(
        store.transaction(async (tx) => {
          const current = structuredClone((await tx.getCampaign(c.id))!);
          current.drsDocument!.revisions = [];
          await tx.saveCampaign(current);
          throw Error('Fixture rollback');
        }),
      ).rejects.toThrow('Fixture rollback');
      expect((await store.getCampaign(c.id))!.drsDocument?.revisions[0].proofs).toHaveLength(2);
    } finally {
      await store.deleteCampaigns([c.id]);
    }
  });

  beforeAll(async () => {
    store = new PostgresStore(url!);
    await store.init();
  });
  afterAll(async () => {
    await store?.close();
  });

  it('rolls back nested user changes and audit together', async () => {
    const email = `rollback-${randomUUID()}@test`;
    const id = randomUUID();
    await expect(
      store.transaction(async (tx) => {
        await tx.saveUser({ email, role: 'viewer', passwordHash: 'fixture', tokenVersion: 0 });
        await tx.transactionUsers(async (users) => {
          const user = await users.getUser(email);
          await users.saveUser({ ...user!, tokenVersion: 1 });
          await users.saveAudit({
            id,
            at: new Date().toISOString(),
            actor: email,
            action: 'store.mutate',
          });
        });
        expect((await tx.getUser(email))?.tokenVersion).toBe(1);
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow('intentional rollback');
    expect(await store.getUser(email)).toBeUndefined();
    expect((await store.listAuditChain()).some((entry) => entry.id === id)).toBe(false);
  });

  it('serialises concurrent mutations without losing session revocations', async () => {
    const email = `concurrency-${randomUUID()}@test`;
    await store.saveUser({ email, role: 'viewer', passwordHash: 'fixture', tokenVersion: 0 });
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          store.transactionUsers(async (tx) => {
            const user = await tx.getUser(email);
            await tx.saveUser({ ...user!, tokenVersion: (user!.tokenVersion ?? 0) + 1 });
          }),
        ),
      );
      expect((await store.getUser(email))?.tokenVersion).toBe(8);
    } finally {
      await store.deleteUser(email);
    }
  });

  it('binds a committed mutation to its caller receipt', async () => {
    const email = `receipt-${randomUUID()}@test`;
    await mutationActor.run('operator@test', () =>
      auditedStore(store).saveUser({ email, role: 'viewer', passwordHash: 'fixture' }),
    );
    try {
      const receipt = (await store.listAuditChain()).find((entry) => entry.detail?.includes(email));
      expect(receipt?.actor).toBe('operator@test');
      expect(receipt?.action).toBe('store.mutate');
    } finally {
      await store.deleteUser(email);
    }
  });

  it('excludes a rival runtime and releases the lease when closed', async () => {
    const owner = new PostgresStore(url!);
    const rival = new PostgresStore(url!);
    let ownerClosed = false;
    try {
      expect(await owner.acquireRuntimeLease()).toBe(true);
      expect(await rival.acquireRuntimeLease()).toBe(false);
      await owner.close();
      ownerClosed = true;
      expect(await rival.acquireRuntimeLease()).toBe(true);
    } finally {
      if (!ownerClosed) await owner.close();
      await rival.close();
    }
  });
  it('persists 5000 multisite identities and looks up an individual agent without loading the registry', async () => {
    const prefix = 'fleet-inventory-' + randomUUID();
    const ids = Array.from({ length: 5000 }, (_, i) => prefix + '-' + i);
    const now = new Date().toISOString();
    try {
      for (let start = 0; start < 5000; start += 100)
        await Promise.all(
          ids.slice(start, start + 100).map((id, j) =>
            store.saveFleetDevice({
              id,
              agentId: id,
              name: 'Inventory fixture',
              siteId: 'site-' + Math.floor((start + j) / 50),
              group: 'Fixture',
              profile: 'sensor',
              privateIp: '10.0.0.' + (((start + j) % 50) + 1),
              notes: '',
              createdAt: now,
              updatedAt: now,
            }),
          ),
        );
      expect((await store.getFleetDevice(ids[4999]))?.siteId).toBe('site-99');
      const records = (await store.listFleetDevices()).filter((d) => d.id.startsWith(prefix));
      expect(records).toHaveLength(5000);
      expect(new Set(records.map((d) => d.siteId)).size).toBe(100);
      await expect(
        store.transaction(async (tx) => {
          const device = await tx.getFleetDevice(ids[0]);
          await tx.saveFleetDevice({ ...device!, siteId: 'changed' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await store.getFleetDevice(ids[0]))?.siteId).toBe('site-0');
    } finally {
      for (let start = 0; start < 5000; start += 100)
        await Promise.all(ids.slice(start, start + 100).map((id) => store.deleteFleetDevice(id)));
    }
  }, 60000);
});
