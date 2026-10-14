import type { KillSwitch } from '../modules/probe/probe.js';

/**
 * In-memory registry of the kill switches of running campaigns. These are
 * runtime objects (AbortController) that cannot be persisted: they only live for
 * the duration of the execution, independently of the store.
 */
let stopping = false;
const active = new Map<string, KillSwitch>();

export const kills = {
  set: (campaignId: string, k: KillSwitch): void => void active.set(campaignId, k),
  get: (campaignId: string): KillSwitch | undefined => active.get(campaignId),
  clear: (campaignId: string): void => void active.delete(campaignId),
  isStopping: (): boolean => stopping,
  stopAll: (): void => {
    stopping = true;
    for (const kill of active.values()) kill.trigger('KILLED_MANUAL');
  },
  triggerAll: (): void => {
    for (const kill of active.values()) kill.trigger('KILLED_MANUAL');
  },
  /** Number of runs currently in flight (for the concurrency guard). */
  count: (): number => active.size,
};
