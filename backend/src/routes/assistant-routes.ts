import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import {
  assistantConfigured,
  sanitizeTurns,
  type AssistantConfig,
  type ChatTurn,
} from '../modules/assistant/provider.js';

export interface AssistantRoutesCtx {
  guard: (perm: Permission) => preHandlerHookHandler;
  config: AssistantConfig;
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
  const { guard, config } = ctx;

  // Lightweight status so the UI can show "assistant available / not configured"
  // without leaking the endpoint or key.
  app.get('/api/assistant/status', { preHandler: guard('campaign:read') }, async () => ({
    configured: assistantConfigured(config),
    model: config.model,
  }));

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
        return reply
          .code(400)
          .send({ error: 'expected a non-empty messages array ending with a user turn' });
      }

      const messages: OpenAiMessage[] = [
        { role: 'system', content: config.systemPrompt },
        ...turns,
      ];

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
        send('error', { message: err instanceof Error ? err.message : 'stream failed' });
      } finally {
        clearTimeout(timer);
        res.end();
      }
    },
  );
}
