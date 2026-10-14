// Seeded E2E users — one per role. The password hashes for these live in
// playwright.config.ts (AUTH_USERS); keep the two in sync.
export const ROLES = {
  engineer: { email: 'eng@wedos', password: 'engineer-pass' },
  admin: { email: 'abdelha@wedos', password: 'officer-pass' }, // isolated test owner
  ciso: { email: 'ciso@wedos', password: 'ciso-pass' }, // the approver
  viewer: { email: 'view@wedos', password: 'viewer-pass' },
} as const;

export type RoleName = keyof typeof ROLES;
