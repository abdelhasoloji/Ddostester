import { createHash } from 'node:crypto';
import type { AuditEntry } from './model.js';

/**
 * Tamper-evidence for the audit log (EPIC D). Each entry carries a SHA-256
 * `hash` computed over its immutable fields chained onto the previous entry's
 * hash (`prevHash`). Any mutation of a field, reordering, or deletion of an
 * interior entry breaks the chain and is detectable. This is pure and adds no
 * traffic — it only makes the existing audit trail verifiable.
 *
 * Note: retention pruning removes the oldest entries, so the first *retained*
 * entry's `prevHash` may reference a pruned entry — verification treats it as an
 * accepted anchor. Truncation of the newest entries is caught only against a
 * previously exported `headHash` (included in the export).
 */
export const AUDIT_GENESIS = 'GENESIS';

/** The immutable fields a hash commits to (order is significant). */
function canonical(e: AuditEntry): string {
  return JSON.stringify([e.id, e.at, e.actor, e.action, e.campaignId ?? null, e.detail ?? null]);
}

/** SHA-256 of an entry chained onto `prevHash`, as a hex string. */
export function hashEntry(e: AuditEntry, prevHash: string): string {
  return createHash('sha256')
    .update(`${prevHash}\n${canonical(e)}`)
    .digest('hex');
}

/**
 * Returns `entry` with `prevHash`/`hash` filled by chaining onto `prevHash`.
 * Used by the store at write time.
 */
export function chainEntry(entry: AuditEntry, prevHash: string): AuditEntry {
  return { ...entry, prevHash, hash: hashEntry(entry, prevHash) };
}

export interface ChainVerdict {
  ok: boolean;
  count: number;
  /** Present when the chain is broken: where and why. */
  brokenAt?: { index: number; id: string; reason: 'content' | 'link' | 'missing-hash' };
  /** Hash of the newest entry (chain head), for truncation detection. */
  headHash: string;
}

/**
 * Verifies a chain of entries given oldest-first (chain order). Each entry must
 * carry the `hash`/`prevHash` written by the store. The first entry's `prevHash`
 * is accepted as an anchor (it may point at a pruned predecessor).
 */
export function verifyChain(entries: AuditEntry[]): ChainVerdict {
  let headHash = AUDIT_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.hash || !e.prevHash) {
      return {
        ok: false,
        count: entries.length,
        headHash,
        brokenAt: { index: i, id: e.id, reason: 'missing-hash' },
      };
    }
    // Link: every entry after the anchor must chain onto its predecessor.
    if (i > 0 && e.prevHash !== entries[i - 1].hash) {
      return {
        ok: false,
        count: entries.length,
        headHash,
        brokenAt: { index: i, id: e.id, reason: 'link' },
      };
    }
    // Content: the stored hash must match a recompute over the fields.
    if (e.hash !== hashEntry(e, e.prevHash)) {
      return {
        ok: false,
        count: entries.length,
        headHash,
        brokenAt: { index: i, id: e.id, reason: 'content' },
      };
    }
    headHash = e.hash;
  }
  return { ok: true, count: entries.length, headHash };
}
