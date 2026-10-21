import { describe, expect, it } from 'vitest';
import { DrsClientError, parseClientInput } from '../src/modules/drs/client.js';

const valid = {
  name: 'Acme Payments',
  contacts: [{ name: 'S. Martin', email: 's.martin@acme.eu', role: 'CISO' }],
  scope: {
    reference: 'SOW-2026-10',
    signedAt: '2026-10-02T10:00:00.000Z',
    targets: ['https://pay.acme.eu', 'https://api.acme.eu'],
    maxRps: 8000,
  },
};

describe('client dossier input', () => {
  it('accepts a signed scope and normalises the date', () => {
    const parsed = parseClientInput(valid, new Date('2026-10-20T00:00:00.000Z'));
    expect(parsed.name).toBe('Acme Payments');
    expect(parsed.scope.targets).toHaveLength(2);
    expect(parsed.scope.signedAt).toBe('2026-10-02T10:00:00.000Z');
    expect(parsed.contacts[0].email).toBe('s.martin@acme.eu');
  });

  it('refuses a scope without targets or without an owner contact', () => {
    expect(() => parseClientInput({ ...valid, scope: { ...valid.scope, targets: [] } })).toThrow(
      /scope\.targets/,
    );
    expect(() => parseClientInput({ ...valid, contacts: [] })).toThrow(/contact/);
  });

  it('refuses a future signature and an invalid contact address', () => {
    expect(() =>
      parseClientInput(
        { ...valid, scope: { ...valid.scope, signedAt: '2027-01-01T00:00:00.000Z' } },
        new Date('2026-10-20T00:00:00.000Z'),
      ),
    ).toThrow(/future/);
    expect(() =>
      parseClientInput({ ...valid, contacts: [{ name: 'X', email: 'not-an-address' }] }),
    ).toThrow(/address/);
  });

  it('refuses a non-positive volume ceiling', () => {
    expect(() => parseClientInput({ ...valid, scope: { ...valid.scope, maxRps: 0 } })).toThrow(
      DrsClientError,
    );
  });
});
