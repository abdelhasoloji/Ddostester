import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './types.js';
/** Caller identity is captured by the handler wrapper, including asynchronous continuations. */
export const mutationActor = new AsyncLocalStorage<string>();
export const mutationSessionVersion = new AsyncLocalStorage<number | undefined>();
export const mutationSessionExpiresAt = new AsyncLocalStorage<number | undefined>();
const writes = new Set([
  'saveCampaign',
  'deleteCampaigns',
  'saveRun',
  'saveUser',
  'deleteUser',
  'recordLogin',
  'savePlaybook',
  'deletePlaybook',
  'saveTarget',
  'deleteTarget',
  'setLimits',
  'createBenchRun',
  'claimNextBenchRun',
  'setBenchRunResult',
  'saveBenchCoverage',
]);
/** Every committed mutation includes an atomic, actor-bound receipt, even if a later summary fails. */
export function auditedStore(base: Store): Store {
  return new Proxy(base, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') return method;
      if (!writes.has(String(key))) return method.bind(target);
      return async (...args: unknown[]) =>
        target.transaction(async (tx) => {
          const result = await (
            Reflect.get(tx, key) as (...args: unknown[]) => Promise<unknown>
          ).apply(tx, args);
          if ((key === 'claimNextBenchRun' || key === 'setBenchRunResult') && !result)
            return result;
          const entity =
            args[0] && typeof args[0] === 'object'
              ? ((args[0] as Record<string, unknown>).id ??
                (args[0] as Record<string, unknown>).runId ??
                (args[0] as Record<string, unknown>).email ??
                'batch')
              : args[0];
          await tx.saveAudit({
            id: randomUUID(),
            at: new Date().toISOString(),
            actor: mutationActor.getStore() ?? 'system',
            action: 'store.mutate',
            detail: `${String(key)} entity=${String(entity ?? 'none')} sha256=${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`,
          });
          return result;
        });
    },
  });
}
