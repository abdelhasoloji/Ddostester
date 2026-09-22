/**
 * assistant/provider.ts — configuration for the conversational assistant that
 * fronts an OpenAI-compatible LLM endpoint (self-hosted Qwen via llama.cpp).
 *
 * SCOPE / SAFETY: this first increment is a READ-ONLY conversational bridge. The
 * assistant can talk and reason; it holds NO capability to launch campaigns,
 * run commands, or touch either server. Any future action layer must go through
 * the platform's existing governance (approval workflow, HARD_CAPS, kill-switch)
 * — never through this chat path directly.
 *
 * Fail-soft: no ASSISTANT_ENDPOINT configured → `configured:false` and the route
 * returns a clear "not configured" status instead of failing, mirroring the
 * other providers in this codebase.
 */

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

/** The defensive charter transmitted to the model on every conversation. */
export const DEFAULT_SYSTEM_PROMPT = [
  'Tu es un assistant Security Engineer / hacker éthique intégré à WEDOS ShieldTest,',
  'un control plane de test de résilience STRICTEMENT DÉFENSIF.',
  'Cadre non négociable : autorisation explicite avant tout test (scope + Rules of',
  'Engagement), légalité (NIS2/DORA/RGPD, loi Godfrain), aucune nuisance (tests',
  'bornés, réversibles, capés, kill-switch), divulgation responsable, rigueur et',
  'preuve, confidentialité. Pensée adverse UNIQUEMENT au service de la défense.',
  'Tu refuses de cibler des tiers non autorisés et de produire du code offensif',
  'réutilisable (amplification, spoofing, exhaustion illimitée) ; tu proposes',
  "alors l'alternative défensive.",
  "Dans cette interface tu ne peux QUE converser et raisonner : tu n'exécutes",
  'aucune commande et tu ne lances aucune campagne. Quand une action est',
  "souhaitée, tu la formules comme une proposition que l'opérateur validera dans",
  'le control plane, via la gouvernance existante. Réponds concis, technique,',
  'en français, actionnable.',
].join(' ');

const num = (v: string | undefined, dflt: number): number =>
  v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt;

/** Reads the assistant configuration from the environment. */
export function assistantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  return {
    endpoint: env.ASSISTANT_ENDPOINT?.trim() || undefined,
    apiKey: env.ASSISTANT_API_KEY?.trim() || undefined,
    model: env.ASSISTANT_MODEL?.trim() || 'qwen',
    timeoutMs: num(env.ASSISTANT_TIMEOUT_MS, 120000),
    maxTokens: num(env.ASSISTANT_MAX_TOKENS, 1200),
    systemPrompt: env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
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
  for (const raw of input.slice(-maxTurns)) {
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      turns.push({ role, content: content.slice(0, maxChars) });
    }
  }
  return turns;
}
