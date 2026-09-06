import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AuditEntry } from '../src/modules/audit/model.js';
import {
  AUDIT_GENESIS,
  chainEntry,
  hashEntry,
  verifyChain,
} from '../src/modules/audit/integrity.js';

const ACTIONS: AuditEntry['action'][] = [
  'campaign.create',
  'campaign.approve',
  'campaign.reject',
  'campaign.execute',
  'campaign.kill',
  'user.upsert',
  'user.delete',
  'playbook.upsert',
  'playbook.delete',
];

const entryArb = fc.record({
  id: fc.uuid(),
  at: fc
    .date({ min: new Date('2020-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
    .map((d) => d.toISOString()),
  actor: fc.string(),
  action: fc.constantFrom(...ACTIONS),
  campaignId: fc.option(fc.uuid(), { nil: undefined }),
  detail: fc.option(fc.string(), { nil: undefined }),
});

/** Chains a list of raw entries onto GENESIS, as the store does at write time. */
function build(entries: AuditEntry[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  let prev = AUDIT_GENESIS;
  for (const e of entries) {
    const c = chainEntry(e, prev);
    out.push(c);
    prev = c.hash as string;
  }
  return out;
}

describe('audit chain — basics', () => {
  it('an empty chain is valid', () => {
    expect(verifyChain([])).toMatchObject({ ok: true, count: 0, headHash: AUDIT_GENESIS });
  });

  it('the first entry chains onto GENESIS and headHash is the last hash', () => {
    const [e] = build([
      { id: 'a', at: '2020-01-01T00:00:00Z', actor: 'x', action: 'campaign.create' },
    ]);
    expect(e.prevHash).toBe(AUDIT_GENESIS);
    expect(e.hash).toBe(hashEntry(e, AUDIT_GENESIS));
    expect(verifyChain([e]).headHash).toBe(e.hash);
  });

  it('flags an entry missing its hash', () => {
    const chain = build([
      { id: 'a', at: '2020-01-01T00:00:00Z', actor: 'x', action: 'campaign.kill' },
    ]);
    delete chain[0].hash;
    expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: { reason: 'missing-hash' } });
  });
});

describe('audit chain — properties', () => {
  it('a freshly built chain always verifies', () => {
    fc.assert(
      fc.property(fc.array(entryArb), (entries) => {
        expect(verifyChain(build(entries)).ok).toBe(true);
      }),
    );
  });

  it('mutating any field of any entry is detected (content break)', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 1 }), fc.nat(), (entries, pick) => {
        const chain = build(entries);
        const i = pick % chain.length;
        chain[i] = { ...chain[i], actor: `${chain[i].actor}~tampered` };
        const v = verifyChain(chain);
        expect(v.ok).toBe(false);
        // At the anchor it is a content break; later it may surface as a link break
        // on the following entry — either way the chain is rejected.
        expect(['content', 'link']).toContain(v.brokenAt?.reason);
      }),
    );
  });

  it('deleting an interior entry breaks the link', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 3 }), fc.nat(), (entries, pick) => {
        const chain = build(entries);
        const i = 1 + (pick % (chain.length - 2)); // interior only: not anchor, not tail
        chain.splice(i, 1);
        expect(verifyChain(chain).ok).toBe(false);
      }),
    );
  });

  it('reordering two adjacent entries is detected', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 2 }), fc.nat(), (entries, pick) => {
        const chain = build(entries);
        const i = pick % (chain.length - 1);
        [chain[i], chain[i + 1]] = [chain[i + 1], chain[i]];
        expect(verifyChain(chain).ok).toBe(false);
      }),
    );
  });

  it('pruning the oldest entries keeps the retained tail valid (anchor accepted)', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 3 }), fc.nat(), (entries, pick) => {
        const chain = build(entries);
        const cut = 1 + (pick % (chain.length - 1)); // drop [0..cut)
        expect(verifyChain(chain.slice(cut)).ok).toBe(true);
      }),
    );
  });
});
