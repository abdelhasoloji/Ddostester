import { describe, expect, it } from 'vitest';
import { canDo } from './context.js';
import type { Perm } from './context.js';
import type { Role } from './api.js';

/**
 * The frontend PERMS map is a UX-only mirror of the authoritative backend matrix
 * (backend/src/auth/rbac.ts). It is not a security boundary — the backend
 * enforces — but a drift would show controls a role can't use, or hide ones it
 * can. This locks the expected role → capability table so any accidental edit to
 * PERMS fails CI. If you change one side, change both and update this table.
 */
const ALL_PERMS: Perm[] = [
  'create',
  'approve',
  'cisoApprove',
  'execute',
  'kill',
  'manage',
  'limits',
  'bench',
];

// Mirror of backend MATRIX, projected onto the frontend's short aliases:
//   create↔campaign:create · approve↔campaign:approve · cisoApprove↔campaign:ciso-approve
//   execute↔campaign:execute · kill↔campaign:kill · manage↔user:manage
//   limits↔limits:manage · bench↔bench:* · (read is implicit for every role)
const EXPECTED: Record<Role, Perm[]> = {
  engineer: ['create', 'execute', 'kill'],
  ciso: ['approve', 'cisoApprove', 'kill', 'bench'],
  admin: ['kill', 'manage', 'limits'],
  viewer: [],
};

describe('frontend RBAC mirror', () => {
  for (const role of Object.keys(EXPECTED) as Role[]) {
    it(`grants ${role} exactly its expected capabilities`, () => {
      const granted = ALL_PERMS.filter((p) => canDo(role, p, true));
      expect(new Set(granted)).toEqual(new Set(EXPECTED[role]));
    });
  }

  it('gates nothing when auth is disabled (dev mode)', () => {
    for (const p of ALL_PERMS) expect(canDo('viewer', p, false)).toBe(true);
  });

  it('grants nothing to an unknown/absent role under auth', () => {
    for (const p of ALL_PERMS) expect(canDo(null, p, true)).toBe(false);
  });
});
