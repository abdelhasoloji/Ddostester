/**
 * Roles. Four effective roles with clean separation of duties:
 *  - engineer : creates a campaign AND launches (executes) an approved one.
 *  - ciso     : views + VALIDATES (approves) campaigns; governs the class-C bench.
 *  - admin    : views + ADMINISTERS the platform (users, operational limits).
 *  - viewer   : views only.
 *
 * `officer` is a legacy alias kept for backward compatibility — existing users
 * stored as 'officer' are canonicalised to 'admin' on read (see `canonicalRole`).
 */
export type Role = 'engineer' | 'ciso' | 'admin' | 'viewer';

export const ROLES: readonly Role[] = ['engineer', 'ciso', 'admin', 'viewer'];

export type Permission =
  | 'campaign:read'
  | 'campaign:create'
  // Validate (approve) a campaign — the CISO. Separation of duties: the approver
  // must differ from the author (enforced in campaigns/service.ts).
  | 'campaign:approve'
  // Mandatory dual-control sign-off (optional posture): when enabled, a SECOND
  // CISO co-signs on top of the approval before the campaign can run.
  | 'campaign:ciso-approve'
  // Launch an approved campaign — the engineer. Separation of duties: the
  // executor must differ from the approver (enforced in app.ts).
  | 'campaign:execute'
  | 'campaign:kill'
  // Administer platform users — the admin.
  | 'user:manage'
  // Change the operational limits (effective caps, always ≤ the immutable
  // HARD_CAPS ceiling) — the admin, as part of platform administration.
  | 'limits:manage'
  // Network bench (class C): read the catalogue/runs/verdicts, dispatch a
  // governed run request (executed by an isolated external runner — the control
  // plane never emits the traffic), and record coverage evidence. CISO
  // governance.
  | 'bench:read'
  | 'bench:dispatch'
  | 'bench:attest'
  // Power the self-hosted assistant GPU pod on/off (RunPod stop/resume). It
  // incurs GPU billing, so it is an operator/admin control, audited on every
  // change. It generates NO load and touches no target — pure cost/lifecycle.
  | 'assistant:manage';

// Authoritative permission matrix — enforced on every request by `can()`. The
// frontend keeps a UX-only mirror (`PERMS` in frontend/src/context.tsx) that
// hides controls; it is not a security boundary. Keep the two in step
// (frontend/src/rbac-mirror.test.ts locks them together).
const MATRIX: Record<Role, Permission[]> = {
  // Operator: creates campaigns and launches approved ones. Does NOT approve
  // (separation of duties — the CISO validates).
  engineer: [
    'campaign:read',
    'campaign:create',
    'campaign:execute',
    'campaign:kill',
    'assistant:manage',
  ],
  // Validation / governance: the ONLY role that approves a campaign, plus the
  // dual-control sign-off and the class-C bench governance. Deliberately not an
  // operator (no create/execute) — validation, not operations.
  ciso: [
    'campaign:read',
    'campaign:approve',
    'campaign:ciso-approve',
    'campaign:kill',
    'bench:read',
    'bench:dispatch',
    'bench:attest',
  ],
  // Platform administration: manages users and the operational limits. NOT an
  // operator and NOT an approver (separation of administration from operations
  // and validation).
  admin: ['campaign:read', 'campaign:kill', 'user:manage', 'limits:manage', 'assistant:manage'],
  // Read-only (SOC/NOC).
  viewer: ['campaign:read'],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role]?.includes(perm) ?? false;
}

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

/**
 * Canonicalises a stored/token role string to a current Role, mapping the legacy
 * `officer` id to `admin` so users provisioned before the roles overhaul keep
 * working. Returns undefined for an unknown role.
 */
export function canonicalRole(x: string | undefined): Role | undefined {
  if (!x) return undefined;
  const mapped = x === 'officer' ? 'admin' : x;
  return isRole(mapped) ? mapped : undefined;
}

/**
 * Returns a shallow copy of a stored user with its role canonicalised to a
 * current Role (legacy `officer` → `admin`), or undefined when the stored role
 * maps to no current Role. Every Store applies this on read so both memory and
 * postgres behave identically and a legacy `officer` user is never dropped at
 * the persistence layer — the store-side twin of the login / `resolveIdentity`
 * canonicalisation (without it, `getUser` filtering on `isRole` locks the legacy
 * user out BEFORE the authorization path can canonicalise their role).
 */
export function withCanonicalRole<T extends { role: string }>(
  u: T,
): (Omit<T, 'role'> & { role: Role }) | undefined {
  const role = canonicalRole(u.role);
  return role ? { ...u, role } : undefined;
}
