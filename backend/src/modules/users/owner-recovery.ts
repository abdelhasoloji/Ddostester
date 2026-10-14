import { randomUUID } from 'node:crypto';
import type { Store } from '../../store/types.js';
import { hashPasswordAsync } from '../../auth/passwords.js';
import { passwordProblem } from '../../auth/password-policy.js';

/** Administrative recovery only: transport must hold the exclusive runtime lease. */
export async function recoverOwner(store: Store, password: string, ticket: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(ticket))
    throw new Error('A bounded administrative ticket identifier is required');
  const policy = await store.getAccountPolicy();
  if (!policy?.primaryAdminEmail) throw new Error('Persisted owner policy required');
  const problem = passwordProblem(password, policy.primaryAdminEmail);
  if (problem) throw new Error(problem);
  const passwordHash = await hashPasswordAsync(password);
  await store.transactionUsers(async (tx) => {
    const current = await tx.getAccountPolicy();
    if (current?.primaryAdminEmail !== policy.primaryAdminEmail)
      throw new Error('Owner policy changed during recovery');
    const users = await tx.listUsers();
    const owner = users.find((user) => user.email === current.primaryAdminEmail);
    if (
      !owner ||
      owner.role !== 'admin' ||
      users.some((user) => user.role === 'admin' && user !== owner)
    )
      throw new Error('Recovery requires the existing sole administrator');
    const version = owner.tokenVersion ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || version === Number.MAX_SAFE_INTEGER)
      throw new Error('Invalid session version');
    await tx.saveUser({
      ...owner,
      passwordHash,
      status: 'active',
      mustChangePassword: true,
      tokenVersion: version + 1,
    });
    await tx.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: `administrative-recovery:${ticket}`,
      action: 'user.owner.recovered',
      detail: `owner=${owner.email}; sessions revoked; temporary password required`,
    });
  });
}
