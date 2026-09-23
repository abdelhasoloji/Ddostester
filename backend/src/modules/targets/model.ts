/**
 * targets/model.ts — Protected targets (governed onboarding).
 *
 * A "protected target" is a host onboarded into the estate as a protected zone.
 * Registering one is metadata only and grants NO permission to generate load.
 * Testing a host still requires it to be in the EFFECTIVE allowlist, which is the
 * env `ALLOWLIST` plus the targets whose `authStatus === 'authorized'` here.
 *
 * Authorization is governed with separation of duties, mirroring the campaign
 * approval model: an operator (`target:manage`) registers the zone and REQUESTS
 * authorization with an explicit attestation (proof of ownership / mandate to
 * test); a CISO (`target:authorize`) — who MUST be a different person than the
 * requester — grants it, which adds the host to the effective allowlist, or
 * revokes it, which removes it again. Every transition is audited.
 *
 * The allowlist ceiling and HARD_CAPS are untouched: authorizing a target lets
 * bounded, governed campaigns run against it — it never widens caps or bypasses
 * approval, attestation, or the kill switch.
 */

export type TargetAuthStatus = 'unauthorized' | 'requested' | 'authorized' | 'revoked';

export interface ProtectedTarget {
  id: string;
  /** Bare hostname — the allowlist unit (no scheme/port/path). */
  host: string;
  /** Customer / zone display name. */
  displayName?: string;
  notes?: string;
  /** Owner / point of contact for the protected host. */
  owner?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  authStatus: TargetAuthStatus;
  /** The requester's authorization statement (ownership / mandate to test). */
  authAttestation?: string;
  authRequestedBy?: string;
  authRequestedAt?: string;
  authorizedBy?: string;
  authorizedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
}

export class TargetError extends Error {}

/**
 * Normalises a URL or bare host to a lowercase bare hostname — the allowlist
 * unit (the campaign allowlist check compares `new URL(target).hostname`).
 * Throws a TargetError on empty / invalid input.
 */
export function normalizeHost(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) throw new TargetError('host is required');
  let host = raw;
  try {
    // Parse as a URL when a scheme is present; otherwise wrap it so a bare
    // "host:port/path" still yields a clean hostname.
    const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : new URL(`http://${raw}`);
    host = u.hostname;
  } catch {
    throw new TargetError(`invalid host: ${raw}`);
  }
  host = host.toLowerCase().replace(/\.$/, '');
  // A hostname is a dotted label set or an IP; reject obviously bad values.
  if (!host || /\s/.test(host) || !/^[a-z0-9._-]+$/i.test(host)) {
    throw new TargetError(`invalid host: ${raw}`);
  }
  return host;
}

const clip = (s: string | undefined, n: number): string | undefined => {
  const v = (s ?? '').trim();
  return v ? v.slice(0, n) : undefined;
};

export interface CreateTargetInput {
  host: string;
  displayName?: string;
  notes?: string;
  owner?: string;
}

/** Builds a new, UNAUTHORIZED protected target (metadata only). */
export function createTarget(
  input: CreateTargetInput,
  ctx: { id: string; by: string; now?: string },
): ProtectedTarget {
  const host = normalizeHost(input.host);
  const now = ctx.now ?? new Date().toISOString();
  return {
    id: ctx.id,
    host,
    displayName: clip(input.displayName, 120),
    notes: clip(input.notes, 2000),
    owner: clip(input.owner, 120),
    createdBy: ctx.by,
    createdAt: now,
    updatedAt: now,
    authStatus: 'unauthorized',
  };
}

export interface UpdateTargetInput {
  displayName?: string | null;
  notes?: string | null;
  owner?: string | null;
  host?: string;
}

/**
 * Edits a target's metadata. Name / owner / notes are always editable (pass an
 * empty string or null to clear a field). The host is the allowlist unit, so it
 * can only be changed while the target is NOT authorized — otherwise it would
 * silently swap what is allowlisted; revoke first. Does not touch the auth state.
 */
export function updateTarget(
  t: ProtectedTarget,
  input: UpdateTargetInput,
  now = new Date().toISOString(),
): ProtectedTarget {
  const next: ProtectedTarget = { ...t, updatedAt: now };
  if (input.displayName !== undefined) next.displayName = clip(input.displayName ?? '', 120);
  if (input.notes !== undefined) next.notes = clip(input.notes ?? '', 2000);
  if (input.owner !== undefined) next.owner = clip(input.owner ?? '', 120);
  if (input.host !== undefined) {
    if (t.authStatus === 'authorized') {
      throw new TargetError('revoke the target before changing the host of an authorized target');
    }
    next.host = normalizeHost(input.host);
  }
  return next;
}

/**
 * Requests authorization to test the host. Requires a non-empty attestation.
 * Allowed from `unauthorized` or `revoked` (re-request). A target already
 * `authorized` needs no request; a pending `requested` is idempotent-updated.
 */
export function requestAuthorization(
  t: ProtectedTarget,
  by: string,
  attestation: string,
  now = new Date().toISOString(),
): ProtectedTarget {
  const att = (attestation ?? '').trim();
  if (att.length < 10) {
    throw new TargetError('an authorization attestation (ownership / mandate to test) is required');
  }
  if (t.authStatus === 'authorized') {
    throw new TargetError('target is already authorized');
  }
  return {
    ...t,
    authStatus: 'requested',
    authAttestation: att.slice(0, 4000),
    authRequestedBy: by,
    authRequestedAt: now,
    updatedAt: now,
    // Clear any prior grant/revocation metadata on a fresh request.
    authorizedBy: undefined,
    authorizedAt: undefined,
    revokedBy: undefined,
    revokedAt: undefined,
  };
}

/**
 * Grants authorization — adds the host to the effective allowlist. Separation of
 * duties: the authorizer MUST differ from the requester. Only a `requested`
 * target can be authorized.
 */
export function authorizeTarget(
  t: ProtectedTarget,
  by: string,
  now = new Date().toISOString(),
): ProtectedTarget {
  if (t.authStatus !== 'requested') {
    throw new TargetError('only a target with a pending authorization request can be authorized');
  }
  if (t.authRequestedBy && by === t.authRequestedBy) {
    throw new TargetError('separation of duties: the authorizer must differ from the requester');
  }
  return {
    ...t,
    authStatus: 'authorized',
    authorizedBy: by,
    authorizedAt: now,
    updatedAt: now,
  };
}

/**
 * Revokes authorization — removes the host from the effective allowlist. Allowed
 * from `authorized` (or `requested`, to reject a pending request).
 */
export function revokeTarget(
  t: ProtectedTarget,
  by: string,
  now = new Date().toISOString(),
): ProtectedTarget {
  if (t.authStatus !== 'authorized' && t.authStatus !== 'requested') {
    throw new TargetError('only an authorized or requested target can be revoked');
  }
  return {
    ...t,
    authStatus: 'revoked',
    revokedBy: by,
    revokedAt: now,
    updatedAt: now,
  };
}

/** The hosts currently authorized for testing — the store's contribution to the effective allowlist. */
export function authorizedHosts(targets: ProtectedTarget[]): string[] {
  return targets.filter((t) => t.authStatus === 'authorized').map((t) => t.host);
}
