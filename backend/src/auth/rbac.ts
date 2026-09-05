/** Rôles (TSD §4.1) : Security Engineer, Security Officer, SOC/NOC (lecture). */
export type Role = 'engineer' | 'officer' | 'viewer';

export const ROLES: readonly Role[] = ['engineer', 'officer', 'viewer'];

export type Permission =
  'campaign:read' | 'campaign:create' | 'campaign:approve' | 'campaign:execute' | 'campaign:kill';

const MATRIX: Record<Role, Permission[]> = {
  // L'officier peut tout faire côté opérationnel (dont approuver).
  officer: [
    'campaign:read',
    'campaign:create',
    'campaign:approve',
    'campaign:execute',
    'campaign:kill',
  ],
  // L'ingénieur crée et exécute, mais n'approuve pas (séparation des rôles).
  engineer: ['campaign:read', 'campaign:create', 'campaign:execute', 'campaign:kill'],
  // SOC/NOC : lecture + kill switch d'urgence.
  viewer: ['campaign:read', 'campaign:kill'],
};

export function can(role: Role, perm: Permission): boolean {
  return MATRIX[role]?.includes(perm) ?? false;
}

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}
