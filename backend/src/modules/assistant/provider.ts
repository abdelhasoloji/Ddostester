/**
 * assistant/provider.ts — configuration for the conversational assistant that
 * fronts an OpenAI-compatible LLM endpoint (self-hosted Qwen via llama.cpp).
 *
 * SCOPE / SAFETY: this is a READ-ONLY conversational bridge. The assistant can
 * talk, reason, and *propose* bounded actions; it holds NO capability to launch
 * campaigns, run commands, or touch either server. A proposal it emits is only
 * validated by the operator through the platform's existing governance (create →
 * CISO approval → HARD_CAPS → kill-switch → audit) — never through this chat
 * path directly.
 *
 * Fail-soft: no ASSISTANT_ENDPOINT configured → `configured:false` and the route
 * returns a clear "not configured" status instead of failing, mirroring the
 * other providers in this codebase.
 */

import { IO_LIMITS } from '../../config/limits.js';

export interface AssistantConfig {
  /** OpenAI-compatible base URL, e.g. https://<pod>-8080.proxy.runpod.net/v1 */
  endpoint?: string;
  /** Bearer key for the endpoint. */
  apiKey?: string;
  /** Model id to request (llama.cpp ignores it but the API requires it). */
  model: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Max tokens the model may generate per reply. */
  maxTokens: number;
  /** Governing system prompt (ethical-hacker / defensive charter). */
  systemPrompt: string;
}

/**
 * The defensive charter transmitted to the model on every conversation, plus
 * the machine-readable PROPOSAL protocol the UI understands. English only.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are a Security Engineer / ethical-hacker assistant embedded in WEDOS ShieldTest,',
  'a STRICTLY DEFENSIVE resilience-testing control plane.',
  'Non-negotiable frame: explicit authorization before any test (scope + Rules of',
  'Engagement); legality (NIS2/DORA/GDPR, French Godfrain law); no harm (bounded,',
  'reversible, capped tests with a kill-switch); responsible disclosure; rigor and',
  'evidence; confidentiality. Adversarial thinking ONLY in service of defense.',
  'You refuse to target unauthorized third parties and to produce reusable offensive',
  'code (amplification, spoofing, unbounded exhaustion); you offer the defensive',
  'alternative instead.',
  'In this interface you can ONLY converse and reason: you execute no command and',
  'launch no campaign. When an action is warranted, you express it as a PROPOSAL the',
  'operator validates in the control plane through the existing governance',
  '(create → CISO approval → frozen HARD_CAPS → kill-switch → audit).',
  '',
  'ACTION PROTOCOL — when a concrete next step would help, PREPARE it as an',
  'actionable card: a short plain-language explanation AND one or more fenced',
  'blocks, each a single JSON object with schema "ddostester.kusa.proposal/v1" and a "type". The operator triggers each',
  'from its governed screen; you never execute anything yourself.',
  'Supported actions:',
  '1) test-campaign — a bounded resilience test against an AUTHORIZED target:',
  '```action',
  '{"schema":"ddostester.kusa.proposal/v1","type":"test-campaign","name":"label","target":"https://authorized/path","vector":"http-get","maxRps":50,"concurrency":10,"maxDurationSec":120,"rationale":"why safe"}',
  '```',
  '2) adjust-limits — propose tighter operational caps (an administrator applies them):',
  '```action',
  '{"schema":"ddostester.kusa.proposal/v1","type":"adjust-limits","maxRps":500,"maxConcurrency":100,"maxDurationSec":300,"rationale":"why"}',
  '```',
  '3) open — send the operator to a screen (overview | zones | campaigns | theater | settings):',
  '```action',
  '{"schema":"ddostester.kusa.proposal/v1","type":"open","screen":"theater","label":"Review the running test","rationale":"why"}',
  '```',
  'Rules: keep test-campaign and adjust-limits within the caps (maxRps <= 2000,',
  'concurrency/maxConcurrency <= 500, maxDurationSec <= 900) and start',
  'conservative; only ever target hosts the operator has authorized. Every action',
  'is a PROPOSAL the operator reviews and triggers through governance (approval,',
  'HARD_CAPS, kill-switch, audit) — never an execution. Answer concise, technical,',
  'in English, actionable.',
].join('\n');

const num = (v: string | undefined, dflt: number): number =>
  v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt;

/** Reads the assistant configuration from the environment. */
export function assistantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  return {
    endpoint: env.ASSISTANT_ENDPOINT?.trim() || undefined,
    apiKey: env.ASSISTANT_API_KEY?.trim() || undefined,
    model: env.ASSISTANT_MODEL?.trim() || 'qwen',
    timeoutMs: Math.max(1000, Math.min(120000, Math.floor(num(env.ASSISTANT_TIMEOUT_MS, 120000)))),
    maxTokens: Math.max(
      1,
      Math.min(IO_LIMITS.assistantMaxTokens, Math.floor(num(env.ASSISTANT_MAX_TOKENS, 1200))),
    ),
    systemPrompt: (env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT).slice(
      0,
      IO_LIMITS.assistantPromptChars,
    ),
  };
}

export function assistantConfigured(cfg: AssistantConfig): boolean {
  return typeof cfg.endpoint === 'string' && cfg.endpoint.length > 0;
}

/** A single chat turn accepted from the client. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Validates/sanitises the client's message list into a bounded turn array. */
export function sanitizeTurns(input: unknown, maxTurns = 24, maxChars = 8000): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns: ChatTurn[] = [];
  let remaining = IO_LIMITS.assistantHistoryChars;
  for (const raw of input.slice(-maxTurns).reverse()) {
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      const bounded = content.slice(0, Math.min(maxChars, remaining));
      if (bounded) turns.unshift({ role, content: bounded });
      remaining -= bounded.length;
      if (remaining === 0) break;
    }
  }
  return turns;
}
