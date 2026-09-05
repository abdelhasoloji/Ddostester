import type { KillSwitch } from '../modules/probe/probe.js';

/**
 * In-memory registry of the kill switches of running campaigns. These are
 * runtime objects (AbortController) that cannot be persisted: they only live for
 * the duration of the execution, independently of the store.
 */
const active = new Map<string, KillSwitch>();

export const kills = {
  set: (campaignId: string, k: KillSwitch): void => void active.set(campaignId, k),
  get: (campaignId: string): KillSwitch | undefined => active.get(campaignId),
  clear: (campaignId: string): void => void active.delete(campaignId),
};
