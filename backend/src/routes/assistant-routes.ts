import { validateKusaProposal, type ProposalPolicy } from '../modules/assistant/proposals.js';
import {
  ProcessTokenBudget,
  type AssistantTokenBudget,
} from '../modules/assistant/token-budget.js';
import { once } from 'node:events';
import { IO_LIMITS } from '../config/limits.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import {
  assistantConfigured,
  sanitizeTurns,
  type AssistantConfig,
  type ChatTurn,
} from '../modules/assistant/provider.js';
import {
  runpodConfigured,
  podStatus,
  podResume,
  podStop,
  type RunpodConfig,
} from '../modules/assistant/runpod.js';

/** Audit hook for pod power changes (start/stop). */
export type AssistantAudit = (
  req: FastifyRequest,
  action: 'assistant.pod_start' | 'assistant.pod_stop',
  detail?: string,
) => void | Promise<void>;

export interface AssistantRoutesCtx {
  tokenBudget?: AssistantTokenBudget;
  proposalPolicy?: () => Promise<ProposalPolicy>;
  guard: (perm: Permission) => preHandlerHookHandler;
  config: AssistantConfig;
  /** Optional GPU-pod power control (RunPod). Absent → pod is "unmanaged". */
  runpod?: RunpodConfig;
  audit?: AssistantAudit;
  /**
   * Optional live-context provider. Its text is appended to the system prompt on
   * each chat turn so answers reflect real platform state (authorized targets,
   * recent campaigns, caps). Read-only and best-effort — never blocks the chat.
   */
  assistantContext?: (req: FastifyRequest) => Promise<string> | string;
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Registers the conversational assistant surface.
 *
 * SAFETY: read-only conversation only. Both routes are gated by `campaign:read`
 * (any authenticated operator). The chat route is a streaming proxy to an
 * OpenAI-compatible endpoint; it exposes NO capability to launch campaigns or
 * run anything — it only relays text. An action layer, if ever added, must go
 * through the existing approval + HARD_CAPS + kill-switch governance, never here.
 */
export function registerAssistantRoutes(app: FastifyInstance, ctx: AssistantRoutesCtx): void {
  const { guard, config, runpod, audit, assistantContext } = ctx;
  const podManaged = runpod != null && runpodConfigured(runpod);
  const tokenBudget = ctx.tokenBudget ?? new ProcessTokenBudget();

  let activeChats = 0;
  const streams = new Set<FastifyReply['raw']>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  const chatBudget = new Map<string, { at: number; count: number }>();
  let globalBudget = { at: Date.now(), count: 0 };
  const reserveChat = (email: string): boolean => {
    const now = Date.now();
    for (const [key, value] of chatBudget) if (now - value.at >= 60000) chatBudget.delete(key);
    if (now - globalBudget.at >= 60000) globalBudget = { at: now, count: 0 };
    const user = chatBudget.get(email) ?? { at: now, count: 0 };
    if (
      activeChats >= 2 ||
      user.count >= 5 ||
      globalBudget.count >= 20 ||
      (!chatBudget.has(email) && chatBudget.size >= 1000)
    )
      return false;
    activeChats++;
    user.count++;
    globalBudget.count++;
    chatBudget.set(email, user);
    return true;
  };

  app.post(
    '/api/assistant/proposals/validate',
    { preHandler: guard('campaign:read') },
    async (request, reply) => {
      if (!ctx.proposalPolicy)
        return reply.code(503).send({ error: 'Proposal policy unavailable' });
      try {
        return validateKusaProposal(request.body, await ctx.proposalPolicy());
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : 'Invalid proposal' });
      }
    },
  );

  // Lightweight status so the UI can show "assistant available / not configured"
  // without leaking the endpoint or key. `podManaged` tells the UI to drive
  // readiness from the pod power state (below) rather than a static endpoint.
  app.get('/api/assistant/status', { preHandler: guard('campaign:read') }, async () => ({
    configured: assistantConfigured(config),
    model: config.model,
    podManaged,
  }));

  // ── GPU pod power (RunPod stop/resume) ──────────────────────────────────
  // Read the current pod state (any operator). Fail-soft when unmanaged.
  app.get('/api/assistant/pod', { preHandler: guard('campaign:read') }, async () => {
    if (!podManaged || !runpod) return { configured: false, state: 'UNKNOWN' as const };
    return podStatus(runpod);
  });

  // Power on. Gated by `assistant:manage` (incurs GPU billing) + audited.
  app.post(
    '/api/assistant/pod/start',
    { preHandler: guard('assistant:manage') },
    async (req, reply) => {
      if (!podManaged || !runpod) {
        return reply.code(503).send({ error: 'pod_unmanaged', configured: false });
      }
      try {
        await audit?.(req, 'assistant.pod_start', 'intent: requested before external power change');
        const st = await podResume(runpod);
        await audit?.(req, 'assistant.pod_start', `state=${st.state}`);
        return st;
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'runpod error' });
      }
    },
  );

  // Power off — frees the GPU billing. Gated by `assistant:manage` + audited.
  app.post(
    '/api/assistant/pod/stop',
    { preHandler: guard('assistant:manage') },
    async (req, reply) => {
      if (!podManaged || !runpod) {
        return reply.code(503).send({ error: 'pod_unmanaged', configured: false });
      }
      try {
        await audit?.(req, 'assistant.pod_stop', 'intent: requested before external power change');
        const st = await podStop(runpod);
        await audit?.(req, 'assistant.pod_stop', `state=${st.state}`);
        return st;
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'runpod error' });
      }
    },
  );

  app.post(
    '/api/assistant/chat',
    { preHandler: guard('campaign:read') },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!assistantConfigured(config)) {
        return reply.code(503).send({ error: 'assistant_not_configured', configured: false });
      }

      const body = (req.body ?? {}) as { messages?: unknown };
      const turns: ChatTurn[] = sanitizeTurns(body.messages);
      if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
        return reply.code(400).send({
          error: 'expected a non-empty messages array ending with a user turn',
        });
      }

      let systemContent = config.systemPrompt;
      if (assistantContext) {
        try {
          const extra = await assistantContext(req);
          if (extra && extra.trim())
            systemContent += '\n\n' + extra.trim().slice(0, IO_LIMITS.assistantContextChars);
        } catch {
          /* live context is best-effort — never block the chat */
        }
      }
      const messages: OpenAiMessage[] = [{ role: 'system', content: systemContent }, ...turns];

      if (!reserveChat(req.authUser?.email ?? 'dev'))
        return reply.code(429).send({ error: 'assistant capacity exceeded — try again later' });
      let tokenReservation;
      try {
        const units = messages.reduce(
          (sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 64,
          config.maxTokens,
        );
        tokenReservation = await tokenBudget.reserve(req.authUser?.email ?? 'dev', units);
      } catch {
        activeChats--;
        return reply.code(503).send({ error: 'assistant accounting unavailable' });
      }
      if (!tokenReservation) {
        activeChats--;
        return reply.code(429).send({ error: 'assistant daily token reservation budget exceeded' });
      }
      // Take over the socket for Server-Sent Events.
      reply.hijack();
      const res = reply.raw;
      streams.add(res);
      res.once('close', () => streams.delete(res));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const ac = new AbortController();
      const send = async (event: string, data: unknown): Promise<void> => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          await once(res, 'drain', { signal: ac.signal });
      };
      const timer = setTimeout(() => ac.abort(), config.timeoutMs);
      res.on('close', () => ac.abort());
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      try {
        await send('provenance', {
          model: config.model,
          protocol: 'openai-compatible-chat-stream',
          budget: tokenReservation,
        });
        const upstream = await fetch(`${config.endpoint}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: ac.signal,
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            max_tokens: config.maxTokens,
            temperature: 0.6,
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          await send('error', { message: `upstream ${upstream.status}` });
          res.end();
          clearTimeout(timer);
          return;
        }

        const reader = upstream.body.getReader();
        upstreamReader = reader;
        const decoder = new TextDecoder();
        let buf = '';
        let streamBytes = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          streamBytes += value.byteLength;
          if (streamBytes > IO_LIMITS.assistantStreamBytes)
            throw new Error('assistant response exceeds stream byte budget');
          if (Buffer.byteLength(buf, 'utf8') + value.byteLength > 64 * 1024)
            throw new Error('assistant SSE frame exceeds byte budget');
          buf += decoder.decode(value, { stream: true });
          // Parse complete SSE lines from the upstream (llama.cpp emits
          // `data: {json}\n\n`, ending with `data: [DONE]`).
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const delta = j.choices?.[0]?.delta?.content;
              if (delta) await send('delta', { content: delta });
            } catch {
              // partial/non-JSON keepalive line — ignore
            }
          }
        }
        await send('done', { ok: true });
      } catch (err) {
        await send('error', {
          message: err instanceof Error ? err.message : 'stream failed',
        }).catch(() => undefined);
      } finally {
        ac.abort();
        await upstreamReader?.cancel().catch(() => undefined);
        activeChats--;
        clearTimeout(timer);
        res.end();
      }
    },
  );
}
