import { canonicalRole } from './rbac.js';
import type { Role } from './rbac.js';

export type UserStatus = 'active' | 'disabled';

export interface User {
  email: string;
  role: Role;
  passwordHash: string;
  /** Account status. Absent is treated as 'active' (back-compat with old rows). */
  status?: UserStatus;
  /** A temporary password set by an admin — the user must change it at next login. */
  mustChangePassword?: boolean;
  /** ISO timestamp the account was created (store users only). */
  createdAt?: string;
  /** ISO timestamp of the last successful login. */
  lastLoginAt?: string;
  /**
   * Session-revocation counter (default 0). A token carries the version it was
   * minted with; when it no longer matches the user's current version the token
   * is rejected. Bumped on password change/reset, role change and deactivation
   * so those take effect immediately instead of lingering until the token's exp.
   * Timing-independent (unlike a timestamp, two events in the same second still
   * differ).
   */
  tokenVersion?: number;
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
    const role = canonicalRole(u.role);
    if (!u.email || !u.passwordHash || !role) {
      throw new Error('AUTH_USERS: invalid account entry.');
    }
    // Canonicalise the legacy `officer` id to `admin` so pre-overhaul users work.
    map.set(u.email.toLowerCase(), { ...u, role });
  }
  return map;
}
