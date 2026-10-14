import { isRole } from '../../auth/rbac.js';
import type { Role } from '../../auth/rbac.js';
import type { UserStatus } from '../../auth/users.js';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../../auth/password-policy.js';

/**
 * Runtime user management (P0-3). Env-defined users (AUTH_USERS) are the
 * immutable root and are never modified here; store users are additive and
 * officer-managed. These pure guards enforce the invariants that keep the
 * feature safe — no self-lockout, no removing the last ACTIVE officer, no
 * touching an env user — independently of transport, so they are fully
 * unit-tested.
 */

export type UserSource = 'env' | 'store';

export interface ManagedUser {
  email: string;
  role: Role;
  source: UserSource;
  /** Absent = 'active' (env users are always active). */
  status?: UserStatus;
  mustChangePassword?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
}

export class UserError extends Error {}

// Re-exported so existing importers keep resolving the policy floor from here.
export { MIN_PASSWORD_LENGTH };

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isDisabled(u: { status?: UserStatus }): boolean {
  return (u.status ?? 'active') === 'disabled';
}

/** Combines env + store users for display (env takes precedence on collision). */
export function combineUsers(
  env: { email: string; role: Role }[],
  store: {
    email: string;
    role: Role;
    status?: UserStatus;
    mustChangePassword?: boolean;
    createdAt?: string;
    lastLoginAt?: string;
  }[],
): ManagedUser[] {
  const byEmail = new Map<string, ManagedUser>();
  for (const u of store)
    byEmail.set(normalizeEmail(u.email), { ...u, status: u.status ?? 'active', source: 'store' });
  // Env users are the immutable root — always active, never a temp password.
  for (const u of env)
    byEmail.set(normalizeEmail(u.email), { ...u, status: 'active', source: 'env' });
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Active admins — the role that administers users. Never let the last one be
 *  removed or demoted (self-lockout guard). */
function activeAdminCount(users: ManagedUser[]): number {
  return users.filter((u) => u.role === 'admin' && !isDisabled(u)).length;
}

function withUpsert(current: ManagedUser[], email: string, role: Role): ManagedUser[] {
  const existing = current.find((u) => normalizeEmail(u.email) === email);
  const rest = current.filter((u) => normalizeEmail(u.email) !== email);
  return [...rest, { email, role, source: 'store', status: existing?.status ?? 'active' }];
}

export interface UpsertInput {
  email: string;
  role: string;
  password: string;
}

export interface GuardContext {
  envEmails: Set<string>;
  current: ManagedUser[];
  actorEmail: string;
  primaryAdminEmail?: string;
}

/** Validates and authorizes a create/update; returns the normalized target. */
export function assertUpsert(input: UpsertInput, ctx: GuardContext): { email: string; role: Role } {
  const email = normalizeEmail(input.email ?? '');
  if (!EMAIL_RE.test(email)) throw new UserError('A valid email is required.');
  if (!isRole(input.role)) throw new UserError('Invalid role.');
  if (ctx.primaryAdminEmail && input.role === 'admin' && email !== ctx.primaryAdminEmail)
    throw new UserError('Only the owner can have the admin role.');
  const pwProblem = passwordProblem(input.password ?? '', email);
  if (pwProblem) throw new UserError(pwProblem);
  if (ctx.envEmails.has(email)) {
    throw new UserError('This user is defined in AUTH_USERS (env) and cannot be modified here.');
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('You cannot modify your own account.');
  }
  const after = withUpsert(ctx.current, email, input.role);
  if (activeAdminCount(after) < 1) {
    throw new UserError('At least one active administrator must remain.');
  }
  return { email, role: input.role };
}

/**
 * Validates and authorizes a role-only change (no password). Same invariants as
 * upsert: env users are immutable, no self-modify, at least one officer remains,
 * and the target must be an existing store user.
 */
export function assertRoleChange(
  rawEmail: string,
  rawRole: string,
  ctx: GuardContext,
): { email: string; role: Role } {
  const email = normalizeEmail(rawEmail ?? '');
  if (!email) throw new UserError('Email is required.');
  if (!isRole(rawRole)) throw new UserError('Invalid role.');
  if (
    ctx.primaryAdminEmail &&
    ((rawRole === 'admin' && email !== ctx.primaryAdminEmail) ||
      (email === ctx.primaryAdminEmail && rawRole !== 'admin'))
  )
    throw new UserError('The owner must remain the only admin.');
  if (ctx.envEmails.has(email)) {
    throw new UserError('This user is defined in AUTH_USERS (env) and cannot be modified here.');
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('You cannot modify your own account.');
  }
  const existing = ctx.current.find((u) => normalizeEmail(u.email) === email);
  if (!existing || existing.source !== 'store') throw new UserError('User not found.');
  const after = withUpsert(ctx.current, email, rawRole);
  if (activeAdminCount(after) < 1) {
    throw new UserError('At least one active administrator must remain.');
  }
  return { email, role: rawRole };
}

/** Validates and authorizes a delete; returns the normalized target email. */
export function assertDelete(rawEmail: string, ctx: GuardContext): string {
  const email = normalizeEmail(rawEmail ?? '');
  if (email === ctx.primaryAdminEmail) throw new UserError('The owner cannot be deleted.');
  if (!email) throw new UserError('Email is required.');
  if (ctx.envEmails.has(email)) {
    throw new UserError('This user is defined in AUTH_USERS (env) and cannot be deleted here.');
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('You cannot delete your own account.');
  }
  if (!ctx.current.some((u) => normalizeEmail(u.email) === email)) {
    throw new UserError('User not found.');
  }
  const after = ctx.current.filter((u) => normalizeEmail(u.email) !== email);
  if (activeAdminCount(after) < 1) {
    throw new UserError('At least one active administrator must remain.');
  }
  return email;
}

/**
 * Validates an admin password reset: the target must be an existing store user,
 * never an env user, never yourself (use the self-service change for that), and
 * the new password must satisfy the policy.
 */
export function assertReset(
  rawEmail: string,
  newPassword: string,
  ctx: GuardContext,
): { email: string } {
  const email = normalizeEmail(rawEmail ?? '');
  if (!email) throw new UserError('Email is required.');
  if (ctx.envEmails.has(email)) {
    throw new UserError(
      'This user is defined in AUTH_USERS (env); their password is managed via configuration.',
    );
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('Use "change my password" to set your own password.');
  }
  const existing = ctx.current.find((u) => normalizeEmail(u.email) === email);
  if (!existing || existing.source !== 'store') throw new UserError('User not found.');
  const pwProblem = passwordProblem(newPassword, email);
  if (pwProblem) throw new UserError(pwProblem);
  return { email };
}

/**
 * Validates an activate/deactivate: never an env user, never yourself (no
 * self-lockout), the target must exist, and deactivating must not remove the
 * last active officer.
 */
export function assertStatusChange(
  rawEmail: string,
  rawStatus: string,
  ctx: GuardContext,
): { email: string; status: UserStatus } {
  const email = normalizeEmail(rawEmail ?? '');
  if (!email) throw new UserError('Email is required.');
  if (rawStatus !== 'active' && rawStatus !== 'disabled') {
    throw new UserError('Status must be "active" or "disabled".');
  }
  const status = rawStatus as UserStatus;
  if (email === ctx.primaryAdminEmail && status === 'disabled')
    throw new UserError('The owner cannot be deactivated.');
  if (ctx.envEmails.has(email)) {
    throw new UserError('This user is defined in AUTH_USERS (env) and cannot be modified here.');
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('You cannot change your own account status.');
  }
  const existing = ctx.current.find((u) => normalizeEmail(u.email) === email);
  if (!existing || existing.source !== 'store') throw new UserError('User not found.');
  const after = ctx.current.map((u) => (normalizeEmail(u.email) === email ? { ...u, status } : u));
  if (activeAdminCount(after) < 1) {
    throw new UserError('At least one active administrator must remain.');
  }
  return { email, status };
}
