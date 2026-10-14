import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { drsReference, digest } from '../src/modules/drs/reference.js';
import { classifyRatio, assessDrs, qualify, verifyProofChain } from '../src/modules/drs/scoring.js';
import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
  simulate,
  finalize,
  appendProof,
} from '../src/modules/drs/workflow.js';
import { validatePlan, validateEvidence } from '../src/modules/drs/model.js';
import { drsReportHtml } from '../src/modules/drs/report.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
const campaign: Campaign = {
  id: randomUUID(),
  name: 'Isolated engine fixture',
  status: 'PENDING_APPROVAL',
  createdBy: 'fixture',
  createdAt: new Date().toISOString(),
  target: 'http://lab-target:8080/',
  probeUrl: 'http://lab-target:8080/',
  authorized: true,
  agent: 'fleet',
  vector: 'http-get',
  maxRps: 3,
  concurrency: 3,
  maxDurationSec: 20,
  fleetDeviceIds: ['one'],
};
function revision(
  mode: 'engine-validation' | 'synthetic-lab' | 'measured' = 'engine-validation',
  level = 1,
) {
  const p = defaultPlan(campaign, mode);
  p.maxLevel = level;
  const d = createRevision(undefined, p, 'fixture');
  const r = currentRevision(d);
  freeze(r, campaign);
  return r;
}
describe('Archived standard and conservative interpretation', () => {
  it('preserves every table row with source strings and pages, including contradictory values', () => {
    const c = drsReference();
    expect(c.vectors).toHaveLength(131);
    expect(c.manifest.version).toBe('3.00.00');
    expect(new Set(c.vectors.map((v) => v.internal_id)).size).toBe(131);
    expect(
      c.vectors.find((v) => v.source_vector_id === '323006')?.service_requirements.max_out,
    ).toBe('10m');
    expect(c.ambiguities.find((a) => a.id === '323006-outage')?.review_status).toBe('unresolved');
    for (const v of c.vectors) {
      expect(v.source_page).toBeGreaterThanOrEqual(17);
      expect(v.source_text).toContain(v.source_vector_id);
    }
  });
  it.each([
    [3, 4, 1, 'MET'],
    [17, 20, 4, 'MET'],
    [2, 5, 1, 'MET'],
    [1, 5, 1, 'FAIL'],
    [4, 5, 1, 'PASS'],
    [18, 20, 7, 'PASS'],
  ] as const)('does not round or invent equality: %s/%s at level %s', (p, t, l, want) => {
    expect(classifyRatio(p, t, l)).toBe(want);
  });
  it('rejects malformed counts', () => {
    expect(() => classifyRatio(1, 0, 1)).toThrow();
    expect(() => classifyRatio(6, 5, 1)).toThrow();
  });
});
describe('Evidence-driven scoring', () => {
  it('produces a simulation-only score, no physical measurement or certification', () => {
    const r = revision();
    const a = simulate(r, 'fixture', 'healthy');
    expect(a.score).toBe(1);
    expect(a.status).toBe('COMPLETE');
    expect(a.label).toMatch(/Simulation/);
    expect(a.certification).toBe(false);
    expect(r.proofs).toHaveLength(2);
    expect(verifyProofChain(r)).toBe(true);
    expect(finalize(r).score).toBe(1);
    expect(r.state).toBe('FINAL_REPORT');
    expect(drsReportHtml(r)).toContain('no resilience measurement');
  });
  it('never turns saturation or telemetry loss into protection success', () => {
    for (const fixture of ['generator-saturation', 'telemetry-gap'] as const) {
      const a = simulate(revision(), 'fixture', fixture);
      expect(a.score).toBeNull();
      expect(a.status).toBe('PARTIAL');
      expect(a.conclusions.every((c) => c.result === 'NOT_EVALUATED')).toBe(true);
    }
  });
  it('does not invent a score when the first level fails', () => {
    const a = simulate(revision(), 'fixture', 'service-outage');
    expect(a.terminalOutcome).toBe('FAIL');
    expect(a.score).toBeNull();
    expect(a.conclusions.every((c) => c.result === 'FAIL')).toBe(true);
  });
  it('uses the previous passed level after a final failure', () => {
    const r = revision('engine-validation', 2);
    simulate(r, 'fixture', 'healthy');
    for (const p of r.proofs.filter((p) => p.data.vectorId.startsWith('drs-3.00.00-2'))) {
      p.data.legitimate_transaction_success[0].successful = 0;
    }
    let prev: string | null = null;
    for (const p of r.proofs) {
      p.previousHash = prev;
      p.hash = digest({
        previousHash: prev,
        id: p.id,
        actor: p.actor,
        at: p.at,
        provenance: p.provenance,
        data: p.data,
      });
      prev = p.hash;
    }
    expect(assessDrs(r).score).toBe(1);
    expect(assessDrs(r).terminalLevel).toBe(2);
    expect(assessDrs(r).terminalOutcome).toBe('FAIL');
  });
  it('returns the terminal intermediate score and diagnoses later tests', () => {
    const r = revision('engine-validation', 2);
    simulate(r, 'fixture', 'service-outage');
    const good = structuredClone(r.proofs[0].data);
    good.attemptId = randomUUID();
    good.legitimate_transaction_success[0].successful = 100; // historical failure still wins
    appendProof(r, good, 'fixture', 'simulation');
    expect(assessDrs(r).conclusions[0].result).toBe('FAIL');
    expect(assessDrs(r).diagnosticVectorIds).toHaveLength(3);
    const middle = revision();
    simulate(middle, 'fixture', 'healthy');
    const bad = structuredClone(middle.proofs[0].data);
    bad.attemptId = randomUUID();
    bad.legitimate_transaction_success[0].successful = 0;
    appendProof(middle, bad, 'fixture', 'simulation');
    expect(assessDrs(middle).score).toBe(0.5);
    expect(assessDrs(middle).terminalOutcome).toBe('MET');
  });
  it('keeps the full denominator and excludes missing scenarios from successes', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    r.proofs.pop();
    const a = assessDrs(r);
    expect(a.levels[0].total).toBe(2);
    expect(a.levels[0].passed).toBe(1);
    expect(a.score).toBeNull();
    expect(a.levels[0].upperBound).toBe(1);
  });
  it('keeps excluded vectors and services visible as partial coverage', () => {
    const r = revision();
    r.plan.excludedVectors = [
      {
        vectorId: 'drs-3.00.00-111001',
        reason: 'Unsupported generator; diagnostic exclusion only',
      },
    ];
    r.planHash = digest({ reference: r.reference, plan: r.plan });
    simulate(r, 'fixture', 'healthy');
    const a = assessDrs(r);
    expect(a.score).toBeNull();
    expect(a.levels[0].total).toBe(2);
    expect(a.levels[0].excluded).toBe(1);
  });
  it('retains failures across retries and revisions', () => {
    const r = revision();
    simulate(r, 'fixture', 'service-outage');
    simulate(r, 'fixture', 'healthy');
    expect(assessDrs(r).conclusions.every((c) => c.result === 'FAIL')).toBe(true);
    expect(r.proofs).toHaveLength(4);
    const next = createRevision(
      { currentRevision: 1, revisions: [r] },
      { ...r.plan, protectionConfiguration: 'Changed configuration' },
      'fixture',
    );
    expect(next.currentRevision).toBe(2);
    expect(next.revisions[0].proofs).toHaveLength(4);
    expect(next.revisions[1].planHash).toBeUndefined();
  });
  it('rejects forged plan changes, reused attempt IDs and tampered proof chains', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    expect(() => appendProof(r, r.proofs[0].data, 'fixture', 'simulation')).toThrow(/Attempt/);
    r.proofs[0].data.requested_load.value = 0;
    expect(verifyProofChain(r)).toBe(false);
    expect(() => assessDrs(r)).toThrow(/integrity/);
    const changed = revision();
    changed.plan.protectionConfiguration = 'Changed';
    expect(() => assessDrs(changed)).toThrow(/integrity/);
  });
  it('cannot relabel simulated measurements as real evidence', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    const physical = revision('measured');
    expect(() => appendProof(physical, r.proofs[0].data, 'fixture', 'simulation')).toThrow(
      /Simulation/,
    );
    const p = structuredClone(r.proofs[1]);
    p.provenance = 'collector-import';
    const a = qualify(drsReference().vectors[1], p, physical);
    expect(a.result).toBe('NOT_EVALUATED');
    expect(a.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/budget/)]));
  });
  it('recognizes a broken functional page with HTTP-like success counters as failure', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    const p = structuredClone(r.proofs[1]);
    p.data.legitimate_transaction_success[0].assertionVerified = false;
    expect(qualify(drsReference().vectors[1], p, r).result).toBe('FAIL');
  });
  it('requires a healthy stable baseline, distribution coverage and recovery evidence', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    for (const change of [
      { baselineStable: false },
      { baselineSeconds: 299 },
      { recovery_timestamp: null },
      { latency_baseline: { ...r.proofs[1].data.latency_baseline, samplesMs: [10] } },
    ]) {
      const p = structuredClone(r.proofs[1]);
      Object.assign(p.data, change);
      expect(qualify(drsReference().vectors[1], p, r).result).toBe('NOT_EVALUATED');
    }
  });
  it('requires common joint exposure rather than separate successful tests', () => {
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    r.proofs[1].data.jointExposureId = 'different';
    let prev: string | null = null;
    for (const p of r.proofs) {
      p.previousHash = prev;
      p.hash = digest({
        previousHash: prev,
        id: p.id,
        actor: p.actor,
        at: p.at,
        provenance: p.provenance,
        data: p.data,
      });
      prev = p.hash;
    }
    expect(assessDrs(r).score).toBeNull();
  });
  it('finalizes a report even with no valid evidence', () => {
    const r = revision('synthetic-lab');
    const a = finalize(r);
    expect(a.status).toBe('INDETERMINATE');
    expect(a.score).toBeNull();
    expect(drsReportHtml(r)).toContain('No usable score');
    expect(() => simulate(r, 'fixture', 'healthy')).toThrow();
  });
  it('rejects shared probe resources and invalid measurements', () => {
    const p = defaultPlan(campaign);
    p.sources.find((s) => s.role === 'user')!.resourceId = 'fleet';
    expect(() => validatePlan(p)).toThrow(/independent/);
    const r = revision();
    simulate(r, 'fixture', 'healthy');
    const e = structuredClone(r.proofs[0].data);
    e.points[0].load!.value = -1;
    expect(() => validateEvidence(e, r.plan)).toThrow();
  });
});

it('does not multiply actual received load by a synthetic factor', () => {
  const r = revision();
  simulate(r, 'fixture', 'healthy');
  const p = structuredClone(r.proofs[1]);
  p.data.points
    .filter((point) => point.load)
    .forEach((point) => {
      point.load!.value = 5;
    });
  Object.assign(p.data, { syntheticFactor: 100 });
  const result = qualify(drsReference().vectors[1], p, r);
  expect(result.result).toBe('NOT_EVALUATED');
  expect(result.reasons).toContain('entry load below standard line');
});
it('terminates at the planned maximum rather than inventing a next level', () => {
  const r = revision('engine-validation', 2);
  const a = simulate(r, 'fixture', 'healthy');
  expect(a.terminalLevel).toBe(2);
  expect(a.score).toBe(2);
  expect(a.levels).toHaveLength(2);
});

it('archives missing latency distributions as unknown, without fabricating a zero mean or a passing vector', () => {
  const r = revision();
  simulate(r, 'fixture', 'healthy');
  const e = structuredClone(r.proofs[0].data);
  e.attemptId = 'missing-latency';
  e.latency_baseline.samplesMs = [];
  e.latency_during_test.samplesMs = [];
  const parsed = validateEvidence(e, r.plan);
  expect(parsed.latency_baseline.meanMs).toBeNull();
  appendProof(r, parsed, 'fixture', 'simulation');
  const p = r.proofs.at(-1)!;
  expect(qualify(drsReference().vectors[0], p, r).result).toBe('NOT_EVALUATED');
});
