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
          if (extra && extra.trim()) systemContent += '\n\n' + extra.trim();
        } catch {
          /* live context is best-effort — never block the chat */
        }
      }
      const messages: OpenAiMessage[] = [{ role: 'system', content: systemContent }, ...turns];

      // Take over the socket for Server-Sent Events.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), config.timeoutMs);
      res.on('close', () => ac.abort());

      try {
        const upstream = await fetch(`${config.endpoint}/chat/completions`, {
          method: 'POST',
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
          send('error', { message: `upstream ${upstream.status}` });
          res.end();
          clearTimeout(timer);
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
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
              if (delta) send('delta', { content: delta });
            } catch {
              // partial/non-JSON keepalive line — ignore
            }
          }
        }
        send('done', { ok: true });
      } catch (err) {
        send('error', {
          message: err instanceof Error ? err.message : 'stream failed',
        });
      } finally {
        clearTimeout(timer);
        res.end();
      }
    },
  );
}
