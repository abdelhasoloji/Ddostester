import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { recoverOwner } from '../src/modules/users/owner-recovery.js';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { verifyChain } from '../src/modules/audit/integrity.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresStore } from '../src/store/postgres.js';

let store: MemoryStore;
beforeEach(async () => {
  store = new MemoryStore();
  await store.init();
  await store.setAccountPolicy({ schemaVersion: 1, primaryAdminEmail: 'abdelha@wedos' });
  await store.saveUser({
    email: 'abdelha@wedos',
    role: 'admin',
    passwordHash: hashPassword('Previous!Password37'),
    tokenVersion: 7,
  });
  await store.saveUser({ email: 'reader@wedos', role: 'viewer', passwordHash: 'untouched' });
});

it('recovers only the owner, revokes sessions and records no credential material', async () => {
  const reader = await store.getUser('reader@wedos');
  await recoverOwner(store, 'Temporary!Recovery37', 'OPS-123');
  const owner = (await store.getUser('abdelha@wedos'))!;
  expect(owner).toMatchObject({
    role: 'admin',
    status: 'active',
    tokenVersion: 8,
    mustChangePassword: true,
  });
  expect(verifyPassword('Temporary!Recovery37', owner.passwordHash)).toBe(true);
  expect(await store.getUser('reader@wedos')).toEqual(reader);
  const chain = await store.listAuditChain();
  expect(chain).toHaveLength(1);
  expect(chain[0]).toMatchObject({
    action: 'user.owner.recovered',
    actor: 'administrative-recovery:OPS-123',
  });
  expect(JSON.stringify(chain)).not.toContain('Temporary!Recovery37');
  expect(JSON.stringify(chain)).not.toContain(owner.passwordHash);
  expect(verifyChain(chain).ok).toBe(true);
});

it('rolls back the password and session version when audit persistence fails', async () => {
  const original = await store.getUser('abdelha@wedos');
  vi.spyOn(store, 'saveAudit').mockRejectedValue(new Error('audit unavailable'));
  await expect(recoverOwner(store, 'Temporary!Recovery37', 'OPS-123')).rejects.toThrow(
    'audit unavailable',
  );
  expect(await store.getUser('abdelha@wedos')).toEqual(original);
});

it('refuses an inconsistent second admin instead of changing other accounts', async () => {
  await store.saveUser({ email: 'other@wedos', role: 'admin', passwordHash: 'untouched' });
  await expect(recoverOwner(store, 'Temporary!Recovery37', 'OPS-123')).rejects.toThrow(
    'sole administrator',
  );
  expect(await store.listAuditChain()).toHaveLength(0);
});

it.skipIf(!process.env.DATABASE_URL_TEST)(
  'repeats recovery on an isolated PostgreSQL database and fences a live control',
  async () => {
    const source = process.env.DATABASE_URL_TEST!;
    const admin = new pg.Pool({ connectionString: source });
    const name = 'owner_recovery_' + randomUUID().replaceAll('-', '');
    const url = new URL(source);
    url.pathname = '/' + name;
    await admin.query(`CREATE DATABASE "${name}"`);
    const recovery = new PostgresStore(url.toString());
    const otherControl = new PostgresStore(url.toString());
    try {
      await recovery.init();
      for (const user of await store.listUsers()) await recovery.saveUser(user);
      await recovery.setAccountPolicy((await store.getAccountPolicy())!);
      expect(await recovery.acquireRuntimeLease()).toBe(true);
      expect(await otherControl.acquireRuntimeLease()).toBe(false);
      const originalReader = await recovery.getUser('reader@wedos');
      await recoverOwner(recovery, 'Temporary!Recovery37', 'OPS-PG-123');
      expect(await recovery.getUser('abdelha@wedos')).toMatchObject({
        role: 'admin',
        tokenVersion: 8,
        mustChangePassword: true,
      });
      expect(await recovery.getUser('reader@wedos')).toEqual(originalReader);
      expect(verifyChain(await recovery.listAuditChain()).ok).toBe(true);
    } finally {
      await otherControl.close();
      await recovery.close();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
