import { isRole } from './rbac.js';
import type { Role } from './rbac.js';

export interface User {
  email: string;
  role: Role;
  passwordHash: string;
}

/**
 * Charge les utilisateurs depuis AUTH_USERS (JSON) :
 *   [{"email":"a@wedos","role":"officer","passwordHash":"scrypt$..."}]
 * Générer un hash : `npm run hash-password -w backend -- <motdepasse>`.
 */
export function loadUsers(raw: string | undefined): Map<string, User> {
  const map = new Map<string, User>();
  if (!raw) return map;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('AUTH_USERS : JSON invalide.');
  }
  if (!Array.isArray(arr)) throw new Error('AUTH_USERS : tableau attendu.');
  for (const u of arr as User[]) {
    if (!u.email || !u.passwordHash || !isRole(u.role)) {
      throw new Error(`AUTH_USERS : entrée invalide (${JSON.stringify(u)}).`);
    }
    map.set(u.email.toLowerCase(), u);
  }
  return map;
}
