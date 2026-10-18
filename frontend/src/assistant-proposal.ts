/**
 * assistant-proposal.ts — parse and validate ACTION PROPOSALS the assistant
 * (Qwen) emits, and map them onto the governed campaign-creation seed.
 *
 * SAFETY / GOVERNANCE: a proposal is a *suggestion*, never an execution. When
 * the operator validates one, it is queued as a draft campaign and opened in the
 * existing recon-first create flow — where it still requires operator review,
 * CISO approval, the frozen HARD_CAPS ceiling (enforced server-side) and the
 * kill-switch. This module only reads text and shapes a form seed; it launches
 * nothing and calls no execution endpoint.
 *
 * Wire protocol: the model emits a single fenced block
 *   ```proposal
 *   { "name": "...", "target": "https://...", "vector": "http-get",
 *     "maxRps": 50, "concurrency": 10, "maxDurationSec": 120, "rationale": "..." }
 *   ```
 * which we lift out of the reply and render as a review card.
 */

import type { CampaignFormSeed } from './campaign-form.js';
import type { HardCaps } from './api.js';

export interface AssistantProposal {
  name: string;
  target: string;
  vector: 'http-get' | 'http-post';
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  rationale: string;
}

function asInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Parse one proposal JSON body; returns null if it is not a valid proposal. */
export function parseProposal(body: string): AssistantProposal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const target = typeof o.target === 'string' ? o.target.trim() : '';
  const maxRps = asInt(o.maxRps);
  const concurrency = asInt(o.concurrency);
  const maxDurationSec = asInt(o.maxDurationSec);
  const vector = o.vector === 'http-post' ? 'http-post' : 'http-get';
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  // A usable proposal needs at least a target and the three load bounds.
  if (!target || maxRps == null || concurrency == null || maxDurationSec == null) return null;
  if (maxRps < 1 || concurrency < 1 || maxDurationSec < 1) return null;
  return {
    name: name || 'Assistant proposal',
    target,
    vector,
    maxRps,
    concurrency,
    maxDurationSec,
    rationale,
  };
}

/**
 * Lift every complete ```proposal``` block out of a reply. Returns the remaining
 * prose (for markdown rendering) and the parsed proposals. Unclosed or invalid
 * blocks are left untouched in the text.
 */
export function extractProposals(content: string): {
  text: string;
  proposals: AssistantProposal[];
} {
  const proposals: AssistantProposal[] = [];
  const text = content.replace(/```proposal[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const p = parseProposal(body);
    if (!p) return whole;
    proposals.push(p);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), proposals };
}

/** Names of the bounds a proposal pushes past the frozen ceiling (display only). */
export function proposalOverCaps(p: AssistantProposal, ceiling: HardCaps): string[] {
  const over: string[] = [];
  if (p.maxRps > ceiling.maxRps) over.push('maxRps');
  if (p.concurrency > ceiling.maxConcurrency) over.push('concurrency');
  if (p.maxDurationSec > ceiling.maxDurationSec) over.push('maxDurationSec');
  return over;
}

/**
 * Map a proposal onto the campaign-creation seed consumed by the governed
 * create flow. Values are clamped to the display ceiling as a courtesy; the
 * authoritative clamp is server-side and non-bypassable.
 */
export function proposalToSeed(p: AssistantProposal, ceiling: HardCaps): Partial<CampaignFormSeed> {
  const clamp = (v: number, ceil: number) => Math.max(1, Math.min(v, ceil));
  return {
    name: p.name,
    target: p.target,
    vector: p.vector,
    maxRps: clamp(p.maxRps, ceiling.maxRps),
    concurrency: clamp(p.concurrency, ceiling.maxConcurrency),
    maxDurationSec: clamp(p.maxDurationSec, ceiling.maxDurationSec),
  };
}
