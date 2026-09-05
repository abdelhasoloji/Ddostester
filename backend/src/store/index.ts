import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './types.js';

export type { Store } from './types.js';

/**
 * Selects the implementation: PostgreSQL if DATABASE_URL is set, otherwise
 * in-memory storage (dev / tests). Initializes the schema at startup.
 */
export async function createStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  const store: Store = url ? new PostgresStore(url) : new MemoryStore();
  await store.init();
  return store;
}
