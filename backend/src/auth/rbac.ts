/** Roles (TSD §4.1): Security Engineer, Security Officer, SOC/NOC (read), CISO. */
export type Role = 'engineer' | 'officer' | 'viewer' | 'ciso';

export const ROLES: readonly Role[] = ['engineer', 'officer', 'viewer', 'ciso'];

export type Permission =
  | 'campaign:read'
  | 'campaign:create'
  | 'campaign:approve'
  // Mandatory CISO sign-off on a campaign (dual control). Separate from
  // 'campaign:approve' (the officer): when the CISO gate is enabled, a campaign
  // is executable only after BOTH the officer approval and this CISO sign-off.
  | 'campaign:ciso-approve'
  | 'campaign:execute'
  | 'campaign:kill'
  | 'user:manage'
  // Change the operational limits (the effective caps, always ≤ the immutable
  // HARD_CAPS ceiling). CISO only — the governance owner of the safety envelope.
  | 'limits:manage'
  // Network bench (class C): read the catalogue/runs/verdicts, and dispatch a
  // governed run request (recorded here, executed by an isolated external runner
  // — the control plane never emits the traffic). CISO only.
  | 'bench:read'
  | 'bench:dispatch'
  // Record coverage evidence for a bench vector (ingested external verdict,
  // control attestation, modelled/replay judgement). CISO only.
  | 'bench:attest';

// Authoritative permission matrix — enforced on every request by `can()`. The
// frontend keeps a UX-only mirror (`PERMS` in frontend/src/context.tsx) that
// hides controls; it is not a security boundary. Keep the two in step.
const MATRIX: Record<Role, Permission[]> = {
  // The officer can do everything operationally (including approve) and manages
  // runtime users (governance). The officer does NOT set the limits — that is
  // the CISO's exclusive control (separation of governance duties).
  officer: [
    'campaign:read',
    'campaign:create',
    'campaign:approve',
    'campaign:execute',
    'campaign:kill',
    'user:manage',
  ],
  // The engineer creates and executes, but does not approve (separation of duties).
  engineer: ['campaign:read', 'campaign:create', 'campaign:execute', 'campaign:kill'],
  // SOC/NOC: read + emergency kill switch.
  viewer: ['campaign:read', 'campaign:kill'],
  // CISO: governs the safety envelope. Reads everything and is the ONLY role
  // that can change the operational limits from the UI. Deliberately not an
  // operator (no create/approve/execute) — governance, not operations.
  ciso: [
    'campaign:read',
    'campaign:kill',
    'campaign:ciso-approve',
    'limits:manage',
    'bench:read',
    'bench:dispatch',
    'bench:attest',
  ],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role]?.includes(perm) ?? false;
}

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}
