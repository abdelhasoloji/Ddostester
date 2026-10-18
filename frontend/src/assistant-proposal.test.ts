import { describe, it, expect } from 'vitest';
import {
  parseProposal,
  extractProposals,
  proposalOverCaps,
  proposalToSeed,
} from './assistant-proposal.js';

const CEILING = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };

const good = JSON.stringify({
  name: 'Baseline burst',
  target: 'https://target.example/health',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 10,
  maxDurationSec: 120,
  rationale: 'Bounded warm-up to observe mitigation behaviour.',
});

describe('parseProposal', () => {
  it('parses a valid proposal', () => {
    const p = parseProposal(good)!;
    expect(p.target).toBe('https://target.example/health');
    expect(p.maxRps).toBe(50);
    expect(p.vector).toBe('http-get');
  });
  it('rejects non-JSON and missing bounds', () => {
    expect(parseProposal('not json')).toBeNull();
    expect(parseProposal('{"target":"https://x"}')).toBeNull();
  });
  it('defaults vector to http-get and coerces numeric strings', () => {
    const p = parseProposal(
      '{"target":"https://x","maxRps":"20","concurrency":"5","maxDurationSec":"60"}',
    )!;
    expect(p.vector).toBe('http-get');
    expect(p.maxRps).toBe(20);
  });
});

describe('extractProposals', () => {
  it('lifts a proposal block out of the prose', () => {
    const content = `Here is a plan.\n\n\`\`\`proposal\n${good}\n\`\`\`\nReview it before launching.`;
    const { text, proposals } = extractProposals(content);
    expect(proposals).toHaveLength(1);
    expect(text).toContain('Here is a plan.');
    expect(text).not.toContain('```proposal');
  });
  it('leaves invalid blocks untouched', () => {
    const content = '```proposal\n{bad}\n```';
    const { proposals, text } = extractProposals(content);
    expect(proposals).toHaveLength(0);
    expect(text).toContain('```proposal');
  });
});

describe('caps + seed', () => {
  it('flags bounds over the ceiling', () => {
    const p = parseProposal(
      JSON.stringify({ target: 'https://x', maxRps: 5000, concurrency: 999, maxDurationSec: 3600 }),
    )!;
    expect(proposalOverCaps(p, CEILING).sort()).toEqual(['concurrency', 'maxDurationSec', 'maxRps']);
  });
  it('clamps the seed to the ceiling', () => {
    const p = parseProposal(
      JSON.stringify({ target: 'https://x', maxRps: 5000, concurrency: 999, maxDurationSec: 3600 }),
    )!;
    const s = proposalToSeed(p, CEILING);
    expect(s.maxRps).toBe(CEILING.maxRps);
    expect(s.concurrency).toBe(CEILING.maxConcurrency);
    expect(s.maxDurationSec).toBe(CEILING.maxDurationSec);
  });
});
