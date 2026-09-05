import type { KillSwitch } from '../modules/probe/probe.js';

/**
 * Registre en mémoire des kill switches des campagnes en cours. Ce sont des
 * objets runtime (AbortController) non persistables : ils ne vivent que le
 * temps de l'exécution, indépendamment du store.
 */
const active = new Map<string, KillSwitch>();

export const kills = {
  set: (campaignId: string, k: KillSwitch): void => void active.set(campaignId, k),
  get: (campaignId: string): KillSwitch | undefined => active.get(campaignId),
  clear: (campaignId: string): void => void active.delete(campaignId),
};
