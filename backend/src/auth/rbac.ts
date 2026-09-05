/** Roles (TSD §4.1): Security Engineer, Security Officer, SOC/NOC (read). */
export type Role = 'engineer' | 'officer' | 'viewer';

export const ROLES: readonly Role[] = ['engineer', 'officer', 'viewer'];

export type Permission =
  'campaign:read' | 'campaign:create' | 'campaign:approve' | 'campaign:execute' | 'campaign:kill';

const MATRIX: Record<Role, Permission[]> = {
  // The officer can do everything operationally (including approve).
  officer: [
    'campaign:read',
    'campaign:create',
    'campaign:approve',
    'campaign:execute',
    'campaign:kill',
  ],
  // The engineer creates and executes, but does not approve (separation of duties).
  engineer: ['campaign:read', 'campaign:create', 'campaign:execute', 'campaign:kill'],
  // SOC/NOC: read + emergency kill switch.
  viewer: ['campaign:read', 'campaign:kill'],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role]?.includes(perm) ?? false;
}

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}
