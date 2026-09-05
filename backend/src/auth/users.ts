import { isRole } from './rbac.js';
import type { Role } from './rbac.js';

export interface User {
  email: string;
  role: Role;
  passwordHash: string;
}

/**
 * Loads users from AUTH_USERS (JSON):
 *   [{"email":"a@wedos","role":"officer","passwordHash":"scrypt$..."}]
 * Generate a hash: `npm run hash-password -w backend -- <password>`.
 */
export function loadUsers(raw: string | undefined): Map<string, User> {
  const map = new Map<string, User>();
  if (!raw) return map;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('AUTH_USERS: invalid JSON.');
  }
  if (!Array.isArray(arr)) throw new Error('AUTH_USERS: array expected.');
  for (const u of arr as User[]) {
    if (!u.email || !u.passwordHash || !isRole(u.role)) {
      throw new Error(`AUTH_USERS: invalid entry (${JSON.stringify(u)}).`);
    }
    map.set(u.email.toLowerCase(), u);
  }
  return map;
}
