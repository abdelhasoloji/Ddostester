/**
 * assistant-action.ts — parse ACTIONABLE items the assistant (Qwen) prepares and
 * map them onto the app's existing governed surfaces. The chat PREPARES; the
 * operator TRIGGERS each action from its normal screen, where RBAC, approvals,
 * HARD_CAPS and the kill-switch all still apply. Nothing here executes anything
 * or calls a mutating endpoint — every action is a one-click hand-off to a
 * governed screen (pre-filled where the app supports it).
 *
 * Wire protocol: the model emits one or more fenced blocks, each a single JSON
 * object with a `type`:
 *   ```action
 *   {"type":"test-campaign","name":"...","target":"https://...","vector":"http-get",
 *    "maxRps":50,"concurrency":10,"maxDurationSec":120,"rationale":"..."}
 *   ```
 *   ```action
 *   {"type":"register-target","host":"staging.example.com","displayName":"Staging",
 *    "owner":"team","notes":"...","rationale":"..."}
 *   ```
 *   ```action
 *   {"type":"adjust-limits","maxRps":500,"maxConcurrency":100,"maxDurationSec":300,
 *    "rationale":"tighten during business hours"}
 *   ```
 *   ```action
 *   {"type":"open","screen":"theater","label":"Review the running campaign","rationale":"..."}
 *   ```
 * Legacy ```proposal``` blocks are still accepted as a test-campaign.
 */

import type { CampaignFormSeed } from './campaign-form.js';
import type { DraftTarget } from './context.js';
import type { HardCaps } from './api.js';
import { parseProposal, proposalToSeed, proposalOverCaps } from './assistant-proposal.js';

/** The governed screens an `open` action may route to. */
export const SCREENS: Record<string, string> = {
  overview: '/',
  zones: '/zones',
  campaigns: '/campaigns',
  theater: '/theater',
  settings: '/settings',
};

export interface ActionRow {
  label: string;
  value: string;
  over?: boolean;
  mono?: boolean;
}

interface Base {
  proposal?: Record<string, unknown>;
  title: string;
  rationale: string;
  rows: ActionRow[];
}

export type AssistantAction =
  | (Base & { kind: 'campaign'; seed: Partial<CampaignFormSeed>; over: string[] })
  | (Base & { kind: 'target'; draft: DraftTarget })
  | (Base & {
      kind: 'limits';
      caps: { maxRps: number; maxConcurrency: number; maxDurationSec: number };
      over: string[];
    })
  | (Base & { kind: 'navigate'; to: string; screen: string });

function asInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function campaignAction(o: Record<string, unknown>, ceiling: HardCaps): AssistantAction | null {
  // Reuse the proposal validation (target + the three bounds).
  const p = parseProposal(JSON.stringify(o));
  if (!p) return null;
  return {
    kind: 'campaign',
    title: p.name,
    rationale: p.rationale,
    seed: proposalToSeed(p, ceiling),
    over: proposalOverCaps(p, ceiling),
    rows: [
      { label: 'Target', value: p.target, mono: true },
      { label: 'Vector', value: p.vector },
      {
        label: 'Max RPS',
        value: String(p.maxRps),
        over: proposalOverCaps(p, ceiling).includes('maxRps'),
      },
      {
        label: 'Concurrency',
        value: String(p.concurrency),
        over: proposalOverCaps(p, ceiling).includes('concurrency'),
      },
      {
        label: 'Duration',
        value: `${p.maxDurationSec}s`,
        over: proposalOverCaps(p, ceiling).includes('maxDurationSec'),
      },
    ],
  };
}

function targetAction(o: Record<string, unknown>): AssistantAction | null {
  const host = str(o.host) || str(o.target);
  if (!host) return null;
  const draft: DraftTarget = {
    host,
    displayName: str(o.displayName) || undefined,
    owner: str(o.owner) || undefined,
    notes: str(o.notes) || undefined,
  };
  const rows: ActionRow[] = [{ label: 'Host', value: host, mono: true }];
  if (draft.displayName) rows.push({ label: 'Name', value: draft.displayName });
  if (draft.owner) rows.push({ label: 'Owner', value: draft.owner });
  return {
    kind: 'target',
    title: draft.displayName || host,
    rationale: str(o.rationale),
    draft,
    rows,
  };
}

function limitsAction(o: Record<string, unknown>, ceiling: HardCaps): AssistantAction | null {
  const maxRps = asInt(o.maxRps);
  const maxConcurrency = asInt(o.maxConcurrency);
  const maxDurationSec = asInt(o.maxDurationSec);
  if (maxRps == null && maxConcurrency == null && maxDurationSec == null) return null;
  const caps = {
    maxRps: maxRps ?? ceiling.maxRps,
    maxConcurrency: maxConcurrency ?? ceiling.maxConcurrency,
    maxDurationSec: maxDurationSec ?? ceiling.maxDurationSec,
  };
  const over: string[] = [];
  if (caps.maxRps > ceiling.maxRps) over.push('maxRps');
  if (caps.maxConcurrency > ceiling.maxConcurrency) over.push('maxConcurrency');
  if (caps.maxDurationSec > ceiling.maxDurationSec) over.push('maxDurationSec');
  return {
    kind: 'limits',
    title: 'Operational limits',
    rationale: str(o.rationale),
    caps,
    over,
    rows: [
      { label: 'Max RPS', value: String(caps.maxRps), over: over.includes('maxRps') },
      {
        label: 'Max concurrency',
        value: String(caps.maxConcurrency),
        over: over.includes('maxConcurrency'),
      },
      {
        label: 'Max duration',
        value: `${caps.maxDurationSec}s`,
        over: over.includes('maxDurationSec'),
      },
    ],
  };
}

function navigateAction(o: Record<string, unknown>): AssistantAction | null {
  const screen = str(o.screen).toLowerCase();
  const to = SCREENS[screen];
  if (!to) return null;
  return {
    kind: 'navigate',
    title: str(o.label) || `Open ${screen}`,
    rationale: str(o.rationale),
    to,
    screen,
    rows: [],
  };
}

function parseAction(o: Record<string, unknown>, ceiling: HardCaps): AssistantAction | null {
  if (o.schema !== undefined && !['test-campaign', 'adjust-limits', 'open'].includes(str(o.type)))
    return null;
  const action = parseLegacyAction(o, ceiling);
  if (action && o.schema !== undefined) action.proposal = { ...o };
  return action;
}

function parseLegacyAction(o: Record<string, unknown>, ceiling: HardCaps): AssistantAction | null {
  const type = str(o.type).toLowerCase();
  switch (type) {
    case 'test-campaign':
    case 'campaign':
    case 'proposal':
      return campaignAction(o, ceiling);
    case 'register-target':
    case 'target':
      return targetAction(o);
    case 'adjust-limits':
    case 'limits':
      return limitsAction(o, ceiling);
    case 'open':
    case 'navigate':
      return navigateAction(o);
    default:
      return null;
  }
}

/**
 * Lift every complete ```action``` (and legacy ```proposal```) block out of a
 * reply. Returns the remaining prose and the parsed actions; invalid or
 * unclosed blocks are left untouched in the text.
 */
export function extractActions(
  content: string,
  ceiling: HardCaps,
): { text: string; actions: AssistantAction[] } {
  const actions: AssistantAction[] = [];
  let text = content.replace(/```action[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    let o: unknown;
    try {
      o = JSON.parse(body);
    } catch {
      return whole;
    }
    if (!o || typeof o !== 'object') return whole;
    const a = parseAction(o as Record<string, unknown>, ceiling);
    if (!a) return whole;
    actions.push(a);
    return '';
  });
  // Legacy proposal blocks → test-campaign.
  text = text.replace(/```proposal[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const p = parseProposal(body);
    if (!p) return whole;
    const a = campaignAction(JSON.parse(body) as Record<string, unknown>, ceiling);
    if (!a) return whole;
    actions.push(a);
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), actions };
}
