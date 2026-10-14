import { expect, it } from 'vitest';
import { assistantConfigFromEnv, sanitizeTurns } from '../src/modules/assistant/provider.js';
it('bounds configured generation and timeout even for negative or excessive values', () => {
  expect(
    assistantConfigFromEnv({ ASSISTANT_MAX_TOKENS: '999999', ASSISTANT_TIMEOUT_MS: '-1' }),
  ).toMatchObject({ maxTokens: 4096, timeoutMs: 1000 });
  expect(assistantConfigFromEnv({ ASSISTANT_MAX_TOKENS: '-10' }).maxTokens).toBe(1);
  expect(assistantConfigFromEnv({ ASSISTANT_MAX_TOKENS: 'NaN' }).maxTokens).toBe(1200);
});
it('keeps newest turns in chronological order within a total history budget', () => {
  const turns = sanitizeTurns(
    Array.from({ length: 24 }, (_, i) => ({
      role: i === 23 ? 'user' : 'assistant',
      content: String(i).padStart(2, '0') + 'x'.repeat(7998),
    })),
  );
  expect(turns.map((t) => t.content.slice(0, 2))).toEqual(['22', '23']);
  expect(turns.reduce((n, t) => n + t.content.length, 0)).toBe(16000);
});
