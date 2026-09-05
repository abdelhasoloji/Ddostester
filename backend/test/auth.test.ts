import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';
import { can } from '../src/auth/rbac.js';
import { loadUsers } from '../src/auth/users.js';
import { initAuth, login, identityFromRequest } from '../src/auth/guard.js';

describe('passwords', () => {
  it('hache et vérifie', () => {
    const h = hashPassword('s3cret!');
    expect(verifyPassword('s3cret!', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});

describe('jwt', () => {
  it('signe et vérifie', () => {
    const t = signJwt({ sub: 'a@wedos', role: 'officer' }, 'secret');
    const p = verifyJwt(t, 'secret');
    expect(p?.sub).toBe('a@wedos');
    expect(p?.role).toBe('officer');
  });
  it('rejette une mauvaise signature', () => {
    const t = signJwt({ sub: 'a@wedos', role: 'officer' }, 'secret');
    expect(verifyJwt(t, 'autre')).toBeNull();
  });
  it('rejette un token expiré', () => {
    const t = signJwt({ sub: 'a', role: 'viewer' }, 'secret', -1);
    expect(verifyJwt(t, 'secret')).toBeNull();
  });
});

describe('rbac', () => {
  it('officier approuve, ingénieur non', () => {
    expect(can('officer', 'campaign:approve')).toBe(true);
    expect(can('engineer', 'campaign:approve')).toBe(false);
    expect(can('engineer', 'campaign:create')).toBe(true);
    expect(can('viewer', 'campaign:create')).toBe(false);
    expect(can('viewer', 'campaign:kill')).toBe(true);
  });
});

describe('users + login', () => {
  const users = JSON.stringify([
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw1') },
  ]);
  it('charge les utilisateurs', () => {
    expect(loadUsers(users).size).toBe(1);
  });
  it('rejette un rôle invalide', () => {
    expect(() => loadUsers('[{"email":"x","role":"root","passwordHash":"h"}]')).toThrow();
  });
  it('login + identité depuis le token', () => {
    const state = initAuth({ AUTH_JWT_SECRET: 'sek', AUTH_USERS: users } as NodeJS.ProcessEnv);
    expect(state.enabled).toBe(true);
    const res = login(state, 'off@wedos', 'pw1');
    expect(res?.role).toBe('officer');
    const id = identityFromRequest(state, { headers: { authorization: `Bearer ${res!.token}` } } as never);
    expect(id?.email).toBe('off@wedos');
    expect(login(state, 'off@wedos', 'bad')).toBeNull();
  });
  it('désactivée sans secret', () => {
    expect(initAuth({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });
});
