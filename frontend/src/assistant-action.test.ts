import { describe, it, expect } from 'vitest';
import { extractActions, SCREENS, LIMIT_CAPS } from './assistant-action.js';

const block = (o: unknown) => '```action\n' + JSON.stringify(o) + '\n```';

describe('extractActions — types', () => {
  it('parses a test-campaign into a campaign action with a seed', () => {
    const { actions, text } = extractActions(
      'Plan:\n' +
        block({
          type: 'test-campaign',
          name: 'Burst',
          target: 'https://t.example/health',
          vector: 'http-get',
          maxRps: 50,
          concurrency: 10,
          maxDurationSec: 120,
          rationale: 'warm-up',
        }),
    );
    expect(actions).toHaveLength(1);
    const a = actions[0];
    expect(a.kind).toBe('campaign');
    if (a.kind === 'campaign') {
      expect(a.seed.target).toBe('https://t.example/health');
      expect(a.seed.maxRps).toBe(50);
    }
    expect(text).toContain('Plan:');
    expect(text).not.toContain('```action');
  });

  it('parses register-target into a target draft', () => {
    const { actions } = extractActions(
      block({ type: 'register-target', host: 'staging.ex.com', displayName: 'Staging', owner: 'sec' }),
    );
    expect(actions[0].kind).toBe('target');
    if (actions[0].kind === 'target') {
      expect(actions[0].draft.host).toBe('staging.ex.com');
      expect(actions[0].draft.displayName).toBe('Staging');
    }
  });

  it('parses adjust-limits and flags over-ceiling values', () => {
    const { actions } = extractActions(
      block({ type: 'adjust-limits', maxRps: 5000, maxConcurrency: 100, maxDurationSec: 300 }),
    );
    const a = actions[0];
    expect(a.kind).toBe('limits');
    if (a.kind === 'limits') {
      expect(a.caps.maxConcurrency).toBe(100);
      expect(a.over).toContain('maxRps');
      expect(a.over).not.toContain('maxConcurrency');
      expect(LIMIT_CAPS.maxRps).toBe(2000);
    }
  });

  it('parses open into a navigate action against a known screen', () => {
    const { actions } = extractActions(
      block({ type: 'open', screen: 'theater', label: 'Review run' }),
    );
    const a = actions[0];
    expect(a.kind).toBe('navigate');
    if (a.kind === 'navigate') {
      expect(a.to).toBe(SCREENS.theater);
      expect(a.title).toBe('Review run');
    }
  });

  it('rejects an unknown screen and an unknown type', () => {
    expect(extractActions(block({ type: 'open', screen: 'nope' })).actions).toHaveLength(0);
    expect(extractActions(block({ type: 'delete-everything' })).actions).toHaveLength(0);
  });

  it('still accepts a legacy ```proposal``` block as a campaign', () => {
    const legacy =
      '```proposal\n' +
      JSON.stringify({ target: 'https://x', maxRps: 20, concurrency: 5, maxDurationSec: 60 }) +
      '\n```';
    const { actions } = extractActions(legacy);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('campaign');
  });

  it('leaves invalid JSON blocks untouched in the text', () => {
    const { actions, text } = extractActions('```action\n{bad}\n```');
    expect(actions).toHaveLength(0);
    expect(text).toContain('```action');
  });
});
