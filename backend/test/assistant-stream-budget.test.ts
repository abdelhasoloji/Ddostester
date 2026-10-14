import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerAssistantRoutes } from '../src/routes/assistant-routes.js';
import { assistantConfigFromEnv } from '../src/modules/assistant/provider.js';

it('refuses exhausted accounting before contacting the provider', async () => {
  const app = Fastify();
  const reserve = vi.fn().mockResolvedValue(undefined);
  registerAssistantRoutes(app, {
    guard: () => async () => {},
    config: assistantConfigFromEnv({ ASSISTANT_ENDPOINT: 'http://provider.invalid/v1' }),
    tokenBudget: { reserve },
  });
  const mock = vi.spyOn(globalThis, 'fetch');
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(429);
    expect(mock).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledOnce();
  } finally {
    mock.mockRestore();
    await app.close();
  }
});

it('bounds a fragmented UTF-8 frame by bytes rather than characters', async () => {
  const app = Fastify();
  registerAssistantRoutes(app, {
    guard: () => async () => {},
    config: assistantConfigFromEnv({ ASSISTANT_ENDPOINT: 'http://provider.invalid/v1' }),
  });
  const cancelled = vi.fn();
  const encoder = new TextEncoder();
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: ' + 'é'.repeat(20000)));
          controller.enqueue(encoder.encode('é'.repeat(15000)));
        },
        cancel: cancelled,
      }),
    ),
  );
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.payload).toContain('assistant SSE frame exceeds byte budget');
    expect(response.payload).not.toContain('event: done');
    expect(cancelled).toHaveBeenCalledOnce();
  } finally {
    mock.mockRestore();
    await app.close();
  }
});

it('interrupts an oversized upstream stream and releases the chat slot', async () => {
  const app = Fastify();
  registerAssistantRoutes(app, {
    guard: () => async () => {},
    config: assistantConfigFromEnv({ ASSISTANT_ENDPOINT: 'http://provider.invalid/v1' }),
  });
  const signals: AbortSignal[] = [];
  const cancelled = vi.fn();
  const encoder = new TextEncoder();
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    signals.push(options!.signal as AbortSignal);
    let count = 0;
    return new Response(
      new ReadableStream({
        cancel: cancelled,
        pull(controller) {
          if (count++ < 20)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(48000) } }] })}\n\n`,
              ),
            );
          else controller.close();
        },
      }),
    );
  });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/assistant/chat',
        payload: { messages: [{ role: 'user', content: 'hello' }] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('assistant response exceeds stream byte budget');
      expect(response.payload).toContain('event: provenance');
      expect(response.payload).toContain('"providerTokens":null');
      expect(response.payload).toContain('"cost":null');
      expect(response.payload).not.toContain('event: done');
      expect(signals[i].aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(i + 1);
    }
  } finally {
    mock.mockRestore();
    await app.close();
  }
});
