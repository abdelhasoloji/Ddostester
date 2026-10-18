import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/store/memory.js';
import { verifyChain } from '../src/modules/audit/integrity.js';
it('does not overwrite a concurrently appended audit when a snapshot commits', async () => {
  const store = new MemoryStore();
  let unblock!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const tx = store.transaction(async (scoped) => {
    await scoped.saveUser({ email: 'user@test', role: 'viewer', passwordHash: 'fixture' });
    started();
    await gate;
    await scoped.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: 'inside',
      action: 'store.mutate',
    });
  });
  await entered;
  const external = store.saveAudit({
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: 'outside',
    action: 'suite.cancel',
  });
  unblock();
  await Promise.all([tx, external]);
  const chain = await store.listAuditChain();
  expect(chain.map((e) => e.actor)).toEqual(['inside', 'outside']);
  expect(verifyChain(chain).ok).toBe(true);
});

it('releases transaction serialization when snapshot preparation fails', async () => {
  const store = new MemoryStore();
  const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
    throw new Error('snapshot unavailable');
  });
  try {
    await expect(store.transaction(async () => true)).rejects.toThrow('snapshot unavailable');
  } finally {
    clone.mockRestore();
  }
  await expect(store.transaction(async () => 'subsequent transaction')).resolves.toBe(
    'subsequent transaction',
  );
});
