import { describe, expect, it } from 'vitest';
import {
  normalizeHost,
  createTarget,
  requestAuthorization,
  authorizeTarget,
  revokeTarget,
  authorizedHosts,
  TargetError,
  type ProtectedTarget,
} from '../src/modules/targets/model.js';
import { MemoryStore } from '../src/store/memory.js';

const mk = (over: Partial<ProtectedTarget> = {}): ProtectedTarget => ({
  ...createTarget(
    { host: 'app.customer.eu' },
    { id: 't1', by: 'eng@x', now: '2026-01-01T00:00:00Z' },
  ),
  ...over,
});

describe('normalizeHost', () => {
  it('reduces URLs / host:port / bare hosts to a lowercase hostname', () => {
    expect(normalizeHost('https://App.Customer.EU/login')).toBe('app.customer.eu');
    expect(normalizeHost('app.customer.eu:8443')).toBe('app.customer.eu');
    expect(normalizeHost('  bank.cz  ')).toBe('bank.cz');
    expect(normalizeHost('46.28.109.92')).toBe('46.28.109.92');
  });
  it('rejects empty / invalid hosts', () => {
    expect(() => normalizeHost('')).toThrow(TargetError);
    expect(() => normalizeHost('   ')).toThrow(TargetError);
    expect(() => normalizeHost('has space.eu')).toThrow(TargetError);
  });
});

describe('lifecycle', () => {
  it('registers unauthorized (metadata only)', () => {
    const t = createTarget(
      { host: 'X.EU', displayName: 'Cust', owner: 'a@x' },
      { id: 't1', by: 'eng@x' },
    );
    expect(t.host).toBe('x.eu');
    expect(t.authStatus).toBe('unauthorized');
    expect(authorizedHosts([t])).toEqual([]);
  });

  it('requires a real attestation to request authorization', () => {
    const t = mk();
    expect(() => requestAuthorization(t, 'eng@x', 'too short')).toThrow(TargetError);
    const req = requestAuthorization(
      t,
      'eng@x',
      'WEDOS is mandated to test this host (signed RoE).',
    );
    expect(req.authStatus).toBe('requested');
    expect(req.authRequestedBy).toBe('eng@x');
    expect(req.authAttestation).toContain('mandated');
  });

  it('authorizes only a requested target, and only by a different person (SoD)', () => {
    const req = requestAuthorization(mk(), 'eng@x', 'authorized to test — ownership on file.');
    expect(() => authorizeTarget(mk(), 'ciso@x')).toThrow(/pending authorization/);
    expect(() => authorizeTarget(req, 'eng@x')).toThrow(/separation of duties/);
    const auth = authorizeTarget(req, 'ciso@x');
    expect(auth.authStatus).toBe('authorized');
    expect(auth.authorizedBy).toBe('ciso@x');
    expect(authorizedHosts([auth])).toEqual(['app.customer.eu']);
  });

  it('revoke removes it from the effective allowlist; re-request is allowed', () => {
    const auth = authorizeTarget(
      requestAuthorization(mk(), 'eng@x', 'authorized to test — ownership on file.'),
      'ciso@x',
    );
    const rev = revokeTarget(auth, 'ciso@x');
    expect(rev.authStatus).toBe('revoked');
    expect(authorizedHosts([rev])).toEqual([]);
    // Re-request after revocation clears prior grant metadata.
    const again = requestAuthorization(rev, 'eng@x', 'renewed mandate, still authorized to test.');
    expect(again.authStatus).toBe('requested');
    expect(again.authorizedBy).toBeUndefined();
  });

  it('cannot authorize an already-authorized or a revoked target directly', () => {
    const auth = authorizeTarget(
      requestAuthorization(mk(), 'eng@x', 'authorized to test — ownership on file.'),
      'ciso@x',
    );
    expect(() => requestAuthorization(auth, 'eng@x', 'again authorized to test here.')).toThrow(
      /already authorized/,
    );
    expect(() => authorizeTarget(auth, 'ciso@x')).toThrow(/pending authorization/);
  });

  it('authorizedHosts only returns hosts in the authorized state', () => {
    const unauth = mk({ host: 'a.eu' });
    const requested = requestAuthorization(
      mk({ host: 'b.eu' }),
      'e@x',
      'authorized to test this host.',
    );
    const authd = authorizeTarget(
      requestAuthorization(mk({ host: 'c.eu' }), 'e@x', 'authorized to test this host.'),
      'ciso@x',
    );
    expect(authorizedHosts([unauth, requested, authd]).sort()).toEqual(['c.eu']);
  });
});

describe('store round-trip', () => {
  it('persists and lists targets in the memory store', async () => {
    const store = new MemoryStore();
    const t = createTarget({ host: 'z.eu' }, { id: 't9', by: 'eng@x' });
    await store.saveTarget(t);
    expect((await store.getTarget('t9'))?.host).toBe('z.eu');
    expect((await store.listTargets()).map((x) => x.host)).toEqual(['z.eu']);
    await store.deleteTarget('t9');
    expect(await store.getTarget('t9')).toBeUndefined();
  });
});
