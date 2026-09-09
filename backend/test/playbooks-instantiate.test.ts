import { describe, it, expect } from 'vitest';
import { PLAYBOOKS, buildSuiteCampaigns } from '../src/modules/playbooks/playbooks.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { HARD_CAPS } from '../src/config/limits.js';

// Instantiation gate for every curated template, exactly as the
// POST /api/playbooks/:id/instantiate endpoint runs it: build the suite of
// campaigns for a target, then push each through createCampaign() (the same
// validation + caps enforcement production uses). No load is generated — this
// only proves every template turns into a valid, in-caps campaign for bank.cz.
const TARGET = 'https://bank.cz';
const ALLOWED = ['bank.cz'];
// Mark the preferred engines available so steps keep their intended engine and
// their endpoint-mix / UA-rotation realism is exercised, not silently dropped.
const ENGINES = [
  { id: 'builtin', available: true },
  { id: 'vegeta', available: true },
  { id: 'k6', available: true },
];
// Real engine capabilities (mirror backend/src/agents/*.ts) so the multi-phase /
// flow validation in createCampaign is exercised faithfully. builtin, vegeta and
// k6 all support multi-phase scenarios (ramp/wave) — the profiles the templates use.
const AGENTS = [
  { id: 'builtin', multiPhase: true, flowCapable: true, correlationCapable: true },
  { id: 'vegeta', multiPhase: true, flowCapable: false, correlationCapable: false },
  { id: 'k6', multiPhase: true, flowCapable: true, correlationCapable: false },
];

describe('curated templates instantiate into valid campaigns for bank.cz', () => {
  it('exposes a stable set of curated templates', () => {
    expect(PLAYBOOKS.length).toBeGreaterThanOrEqual(19);
    // ids are unique
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
  });

  for (const pb of PLAYBOOKS) {
    it(`instantiates "${pb.id}" (${pb.steps.length} step(s)) within caps`, () => {
      const inputs = buildSuiteCampaigns(
        pb,
        { target: TARGET, probeUrl: TARGET, createdBy: 'test' },
        ENGINES,
      );
      expect(inputs.length).toBe(pb.steps.length);

      inputs.forEach((input, i) => {
        // Must not throw — this is the exact production creation gate.
        const c = createCampaign(input, ALLOWED, AGENTS, HARD_CAPS);
        const where = `${pb.id} step ${i + 1} (${pb.steps[i].name})`;
        // Every enforced bound holds.
        expect(c.maxRps, `${where}: maxRps`).toBeLessThanOrEqual(HARD_CAPS.maxRps);
        expect(c.concurrency, `${where}: concurrency`).toBeLessThanOrEqual(
          HARD_CAPS.maxConcurrency,
        );
        expect(c.maxDurationSec, `${where}: duration`).toBeLessThanOrEqual(
          HARD_CAPS.maxDurationSec,
        );
        // Target stayed the allowlisted host, and the suite linkage is intact.
        expect(new URL(c.target).host, `${where}: host`).toBe('bank.cz');
        expect(c.suiteOrder, `${where}: order`).toBe(i);
        // Any resolved endpoints stay on the allowlisted host.
        for (const ep of c.endpoints ?? []) {
          expect(new URL(ep.url).host, `${where}: endpoint host`).toBe('bank.cz');
        }
      });
    });
  }
});
