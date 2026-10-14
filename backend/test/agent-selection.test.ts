import { afterEach, expect, it, vi } from 'vitest';
import { resolveCampaignAgent, selectAgent } from '../src/agents/index.js';
import { BuiltinHttpAgent } from '../src/agents/builtin.js';
import { K6Agent } from '../src/agents/k6.js';
afterEach(() => vi.restoreAllMocks());
it('rejects an unavailable explicit engine without probing or running the default', async () => {
  vi.spyOn(K6Agent.prototype, 'available').mockResolvedValue(false);
  const fallback = new BuiltinHttpAgent();
  const available = vi.spyOn(fallback, 'available');
  const run = vi.spyOn(fallback, 'run');
  await expect(resolveCampaignAgent('k6', fallback)).rejects.toThrow('unavailable');
  expect(available).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
it('uses the default only for an omitted choice and rejects unknown configuration', async () => {
  const fallback = new BuiltinHttpAgent();
  expect(await resolveCampaignAgent(undefined, fallback)).toBe(fallback);
  await expect(resolveCampaignAgent('unknown', fallback)).rejects.toThrow('unknown');
  expect(() => selectAgent({ AGENT: 'unknown' })).toThrow('unknown');
});
