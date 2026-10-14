import { randomUUID } from 'node:crypto';
import type { User } from './users.js';
import type { AuthState } from './guard.js';
import type { Store } from '../store/types.js';
import { hashPasswordAsync } from './passwords.js';
import { passwordProblem } from './password-policy.js';
export type UserMode = 'team' | 'single';
export const DEFAULT_SINGLE_USER_EMAIL = 'abdelha@wedos';
export function userModeFromEnv(env: NodeJS.ProcessEnv): UserMode {
  const mode = env.USER_MODE?.trim() || 'single';
  if (mode !== 'team' && mode !== 'single') throw new Error('USER_MODE must be team or single.');
  return mode;
}
/** Explicit, versioned migration. Does not run as part of ordinary application startup. */
export async function prepareSingleUser(
  store: Store,
  auth: AuthState,
  bootstrapPassword?: string,
): Promise<void> {
  if (!auth.enabled || auth.secret.length < 32)
    throw new Error('Account migration requires a signing secret of at least 32 characters.');
  const email = auth.singleUserEmail?.trim().toLowerCase() || DEFAULT_SINGLE_USER_EMAIL;
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('SINGLE_USER_EMAIL must be a valid email.');
  await store.transactionUsers(async (tx) => {
    const policy = await tx.getAccountPolicy();
    if (policy) {
      if (policy.primaryAdminEmail !== email)
        throw new Error('Owner transfer requires an explicit recovery procedure.');
      return; // Never overwrite passwords, statuses or token versions on restart/retry.
    }
    const users = new Map<string, User>(
      [...auth.users.values()].map((u) => [
        u.email.toLowerCase(),
        { ...u, tokenVersion: (u.tokenVersion ?? 0) + 1 },
      ]),
    );
    for (const u of await tx.listUsers()) users.set(u.email.toLowerCase(), u);
    let owner = users.get(email);
    if (!owner) {
      if (users.size)
        throw new Error('SINGLE_USER_EMAIL must select an existing account for migration.');
      const problem = passwordProblem(bootstrapPassword ?? '', email);
      if (problem) throw new Error(`SINGLE_USER_PASSWORD: ${problem}`);
      owner = {
        email,
        role: 'admin',
        passwordHash: await hashPasswordAsync(bootstrapPassword!),
        status: 'active',
        createdAt: new Date().toISOString(),
        tokenVersion: 1,
      };
    }
    if (owner.role !== 'admin' || owner.status === 'disabled')
      owner = {
        ...owner,
        role: 'admin',
        status: 'active',
        tokenVersion: (owner.tokenVersion ?? 0) + 1,
      };
    users.set(email, owner);
    for (const [key, u] of users) {
      const next =
        key !== email && u.role === 'admin'
          ? { ...u, role: 'viewer' as const, tokenVersion: (u.tokenVersion ?? 0) + 1 }
          : u;
      await tx.saveUser(next);
    }
    await tx.setAccountPolicy({ schemaVersion: 1, primaryAdminEmail: email });
    await tx.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: email,
      action: 'user.single_mode',
      detail:
        'Account policy v1: unique owner, env accounts imported, other statuses and credentials preserved.',
    });
  });
  auth.singleUserEmail = email;
  auth.users.clear();
}

/** Verify persisted ownership and switch to the database identity source, without writes. */
export async function configureAccounts(store: Store, auth: AuthState): Promise<void> {
  const policy = await store.getAccountPolicy();
  if ((policy || auth.userMode === 'single') && (!auth.enabled || auth.secret.length < 32))
    throw new Error('Managed accounts require strong authentication.');
  if (!policy) {
    if (auth.userMode === 'single')
      throw new Error(
        'Account migration required: run the migrate-users CLI with --apply before startup.',
      );
    return; // Legacy team installations can migrate explicitly.
  }
  const users = await store.listUsers();
  const owner = users.find((u) => u.email.toLowerCase() === policy.primaryAdminEmail);
  if (
    !owner ||
    owner.role !== 'admin' ||
    owner.status === 'disabled' ||
    users.filter((u) => u.role === 'admin').length !== 1
  )
    throw new Error('Invalid persisted owner policy; recover explicitly before startup.');
  if (auth.singleUserEmail && auth.singleUserEmail !== policy.primaryAdminEmail)
    throw new Error('Configured administrator differs from persisted owner.');
  auth.singleUserEmail = policy.primaryAdminEmail;
  auth.users.clear();
}
