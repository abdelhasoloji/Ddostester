import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './types.js';

export type { Store } from './types.js';

/**
 * Sélectionne l'implémentation : PostgreSQL si DATABASE_URL est défini,
 * sinon stockage en mémoire (dev / tests). Initialise le schéma au démarrage.
 */
export async function createStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  const store: Store = url ? new PostgresStore(url) : new MemoryStore();
  await store.init();
  return store;
}
