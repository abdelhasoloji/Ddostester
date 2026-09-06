// Seeded E2E users — one per role. The password hashes for these live in
// playwright.config.ts (AUTH_USERS); keep the two in sync.
export const ROLES = {
  engineer: { email: 'eng@wedos', password: 'engineer-pass' },
  officer: { email: 'off@wedos', password: 'officer-pass' },
  viewer: { email: 'view@wedos', password: 'viewer-pass' },
} as const;

export type RoleName = keyof typeof ROLES;
