import { isRole } from '../../auth/rbac.js';
import type { Role } from '../../auth/rbac.js';

/**
 * Runtime user management (P0-3). Env-defined users (AUTH_USERS) are the
 * immutable root and are never modified here; store users are additive and
 * officer-managed. These pure guards enforce the invariants that keep the
 * feature safe — no self-lockout, no removing the last officer, no touching an
 * env user — independently of transport, so they are fully unit-tested.
 */

export type UserSource = 'env' | 'store';

export interface ManagedUser {
  email: string;
  role: Role;
  source: UserSource;
}

export class UserError extends Error {}

export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Combines env + store users for display (env takes precedence on collision). */
export function combineUsers(
  env: { email: string; role: Role }[],
  store: { email: string; role: Role }[],
): ManagedUser[] {
  const byEmail = new Map<string, ManagedUser>();
  for (const u of store) byEmail.set(normalizeEmail(u.email), { ...u, source: 'store' });
  for (const u of env) byEmail.set(normalizeEmail(u.email), { ...u, source: 'env' });
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function officerCount(users: { role: Role }[]): number {
  return users.filter((u) => u.role === 'officer').length;
}

function withUpsert(current: ManagedUser[], email: string, role: Role): ManagedUser[] {
  const rest = current.filter((u) => normalizeEmail(u.email) !== email);
  return [...rest, { email, role, source: 'store' }];
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
}

/** Validates and authorizes a create/update; returns the normalized target. */
export function assertUpsert(input: UpsertInput, ctx: GuardContext): { email: string; role: Role } {
  const email = normalizeEmail(input.email ?? '');
  if (!EMAIL_RE.test(email)) throw new UserError('A valid email is required.');
  if (!isRole(input.role)) throw new UserError('Invalid role.');
  if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (ctx.envEmails.has(email)) {
    throw new UserError('This user is defined in AUTH_USERS (env) and cannot be modified here.');
  }
  if (email === normalizeEmail(ctx.actorEmail)) {
    throw new UserError('You cannot modify your own account.');
  }
  const after = withUpsert(ctx.current, email, input.role);
  if (officerCount(after) < 1) {
    throw new UserError('At least one officer must remain.');
  }
  return { email, role: input.role };
}

/** Validates and authorizes a delete; returns the normalized target email. */
export function assertDelete(rawEmail: string, ctx: GuardContext): string {
  const email = normalizeEmail(rawEmail ?? '');
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
  if (officerCount(after) < 1) {
    throw new UserError('At least one officer must remain.');
  }
  return email;
}
