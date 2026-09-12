import { describe, expect, it } from 'vitest';
import {
  assertDelete,
  assertReset,
  assertRoleChange,
  assertStatusChange,
  assertUpsert,
  combineUsers,
  normalizeEmail,
  UserError,
} from '../src/modules/users/service.js';
import type { ManagedUser } from '../src/modules/users/service.js';

const envOfficer = { email: 'off@wedos', role: 'officer' as const };
const envEmails = new Set([normalizeEmail(envOfficer.email)]);

function ctx(current: ManagedUser[], actorEmail = 'off@wedos') {
  return { envEmails, current, actorEmail };
}

describe('combineUsers', () => {
  it('merges env and store, env winning on collision', () => {
    const out = combineUsers(
      [{ email: 'a@wedos', role: 'officer' }],
      [
        { email: 'a@wedos', role: 'viewer' },
        { email: 'b@wedos', role: 'engineer' },
      ],
    );
    expect(out.find((u) => u.email === 'a@wedos')).toMatchObject({
      role: 'officer',
      source: 'env',
    });
    expect(out.find((u) => u.email === 'b@wedos')).toMatchObject({
      role: 'engineer',
      source: 'store',
    });
  });
});

describe('assertUpsert', () => {
  const current: ManagedUser[] = [{ ...envOfficer, source: 'env' }];

  it('accepts a valid new store user', () => {
    const r = assertUpsert(
      { email: 'Eng@Wedos', role: 'engineer', password: 'aValidPassw0rd' },
      ctx(current),
    );
    expect(r).toEqual({ email: 'eng@wedos', role: 'engineer' });
  });

  it('rejects a short password', () => {
    expect(() =>
      assertUpsert({ email: 'e@wedos', role: 'engineer', password: 'x' }, ctx(current)),
    ).toThrow(UserError);
  });

  it('rejects an invalid role', () => {
    expect(() =>
      assertUpsert({ email: 'e@wedos', role: 'root', password: 'aValidPassw0rd' }, ctx(current)),
    ).toThrow(UserError);
  });

  it('refuses to modify an env-defined user', () => {
    expect(() =>
      assertUpsert(
        { email: 'off@wedos', role: 'viewer', password: 'aValidPassw0rd' },
        ctx(current),
      ),
    ).toThrow(/AUTH_USERS/);
  });

  it('refuses to modify your own account', () => {
    const cur: ManagedUser[] = [
      { ...envOfficer, source: 'env' },
      { email: 'me@wedos', role: 'officer', source: 'store' },
    ];
    expect(() =>
      assertUpsert(
        { email: 'me@wedos', role: 'viewer', password: 'aValidPassw0rd' },
        ctx(cur, 'me@wedos'),
      ),
    ).toThrow(/own account/);
  });

  it('refuses a change that would leave no officer', () => {
    // Only officer is a store user; demoting it to viewer leaves zero officers.
    const cur: ManagedUser[] = [{ email: 'solo@wedos', role: 'officer', source: 'store' }];
    expect(() =>
      assertUpsert(
        { email: 'solo@wedos', role: 'viewer', password: 'aValidPassw0rd' },
        { envEmails: new Set(), current: cur, actorEmail: 'other@wedos' },
      ),
    ).toThrow(/officer/);
  });
});

describe('assertRoleChange', () => {
  const current: ManagedUser[] = [
    { ...envOfficer, source: 'env' },
    { email: 'eng@wedos', role: 'engineer', source: 'store' },
  ];

  it('changes the role of a store user', () => {
    expect(assertRoleChange('eng@wedos', 'viewer', ctx(current))).toEqual({
      email: 'eng@wedos',
      role: 'viewer',
    });
  });

  it('rejects an invalid role', () => {
    expect(() => assertRoleChange('eng@wedos', 'root', ctx(current))).toThrow(UserError);
  });

  it('refuses to change an env user', () => {
    expect(() => assertRoleChange('off@wedos', 'viewer', ctx(current))).toThrow(/AUTH_USERS/);
  });

  it('refuses to change your own account', () => {
    expect(() => assertRoleChange('eng@wedos', 'officer', ctx(current, 'eng@wedos'))).toThrow(
      /own account/,
    );
  });

  it('refuses a non-existent store user', () => {
    expect(() => assertRoleChange('ghost@wedos', 'viewer', ctx(current))).toThrow(/not found/);
  });

  it('refuses to demote the last officer', () => {
    const cur: ManagedUser[] = [{ email: 'solo@wedos', role: 'officer', source: 'store' }];
    expect(() =>
      assertRoleChange('solo@wedos', 'viewer', {
        envEmails: new Set(),
        current: cur,
        actorEmail: 'x@wedos',
      }),
    ).toThrow(/officer/);
  });
});

describe('assertDelete', () => {
  const current: ManagedUser[] = [
    { ...envOfficer, source: 'env' },
    { email: 'eng@wedos', role: 'engineer', source: 'store' },
  ];

  it('deletes a store user (officer remains via env)', () => {
    expect(assertDelete('eng@wedos', ctx(current))).toBe('eng@wedos');
  });

  it('refuses to delete an env user', () => {
    expect(() => assertDelete('off@wedos', ctx(current))).toThrow(/AUTH_USERS/);
  });

  it('refuses to delete your own account', () => {
    expect(() => assertDelete('eng@wedos', ctx(current, 'eng@wedos'))).toThrow(/own account/);
  });

  it('refuses to delete a non-existent user', () => {
    expect(() => assertDelete('ghost@wedos', ctx(current))).toThrow(/not found/);
  });

  it('refuses to delete the last officer', () => {
    const cur: ManagedUser[] = [{ email: 'solo@wedos', role: 'officer', source: 'store' }];
    expect(() =>
      assertDelete('solo@wedos', { envEmails: new Set(), current: cur, actorEmail: 'x@wedos' }),
    ).toThrow(/officer/);
  });

  it('counts a disabled officer as unavailable (last ACTIVE officer)', () => {
    // One env officer is disabled? env is always active, so use a store officer.
    const cur: ManagedUser[] = [
      { email: 'act@wedos', role: 'officer', source: 'store', status: 'active' },
      { email: 'dis@wedos', role: 'officer', source: 'store', status: 'disabled' },
    ];
    // Deleting the only ACTIVE officer must fail even though a disabled one exists.
    expect(() =>
      assertDelete('act@wedos', { envEmails: new Set(), current: cur, actorEmail: 'x@wedos' }),
    ).toThrow(/active officer/);
  });
});

describe('assertReset', () => {
  const current: ManagedUser[] = [
    { ...envOfficer, source: 'env' },
    { email: 'eng@wedos', role: 'engineer', source: 'store' },
  ];

  it('accepts a policy-compliant reset of a store user', () => {
    expect(assertReset('eng@wedos', 'aValidPassw0rd', ctx(current))).toEqual({
      email: 'eng@wedos',
    });
  });

  it('rejects a weak new password', () => {
    expect(() => assertReset('eng@wedos', 'short', ctx(current))).toThrow(/at least 12/);
  });

  it('refuses to reset an env user', () => {
    expect(() => assertReset('off@wedos', 'aValidPassw0rd', ctx(current))).toThrow(/AUTH_USERS/);
  });

  it('refuses to reset your own account (use self-service)', () => {
    expect(() => assertReset('eng@wedos', 'aValidPassw0rd', ctx(current, 'eng@wedos'))).toThrow(
      /change my password/,
    );
  });

  it('refuses a non-existent user', () => {
    expect(() => assertReset('ghost@wedos', 'aValidPassw0rd', ctx(current))).toThrow(/not found/);
  });
});

describe('assertStatusChange', () => {
  const current: ManagedUser[] = [
    { ...envOfficer, source: 'env' },
    { email: 'eng@wedos', role: 'engineer', source: 'store', status: 'active' },
  ];

  it('deactivates a store user', () => {
    expect(assertStatusChange('eng@wedos', 'disabled', ctx(current))).toEqual({
      email: 'eng@wedos',
      status: 'disabled',
    });
  });

  it('rejects an invalid status', () => {
    expect(() => assertStatusChange('eng@wedos', 'paused', ctx(current))).toThrow(
      /active.*disabled/,
    );
  });

  it('refuses to change an env user', () => {
    expect(() => assertStatusChange('off@wedos', 'disabled', ctx(current))).toThrow(/AUTH_USERS/);
  });

  it('refuses to change your own status (no self-lockout)', () => {
    expect(() => assertStatusChange('eng@wedos', 'disabled', ctx(current, 'eng@wedos'))).toThrow(
      /your own account status/,
    );
  });

  it('refuses to disable the last active officer', () => {
    const cur: ManagedUser[] = [
      { email: 'solo@wedos', role: 'officer', source: 'store', status: 'active' },
    ];
    expect(() =>
      assertStatusChange('solo@wedos', 'disabled', {
        envEmails: new Set(),
        current: cur,
        actorEmail: 'x@wedos',
      }),
    ).toThrow(/active officer/);
  });
});
