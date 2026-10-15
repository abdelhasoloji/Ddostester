import { describe, it, expect } from 'vitest';
import { renderDrsMetrics, renderMetrics } from '../src/modules/metrics/prometheus.js';
import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
  simulate,
  finalize,
} from '../src/modules/drs/workflow.js';
import { assessDrs } from '../src/modules/drs/scoring.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
function fixture(id = 'drs-fixture'): Campaign {
  const campaign: Campaign = {
    id,
    name: 'Metrics fixture',
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
  campaign.drsDocument = createRevision(
    undefined,
    defaultPlan(campaign, 'engine-validation'),
    'fixture',
  );
  return campaign;
}
describe('DRS Prometheus projection', () => {
  it('keeps drafts and missing scores distinct from zero and labels simulation', () => {
    const c = fixture();
    expect(renderMetrics([c], 0)).toContain('mode="engine-validation"');
    expect(renderDrsMetrics([c])).not.toContain('shieldtest_drs_score{');
    freeze(currentRevision(c.drsDocument!), c);
    const metrics = renderDrsMetrics([c]);
    expect(metrics).toContain('status="INDETERMINATE"');
    expect(metrics).not.toContain('shieldtest_drs_score{');
    expect(metrics).toContain('coverage="unknown"');
  });
  it('exports the authoritative engine assessment without recomputing thresholds', () => {
    const c = fixture(),
      r = currentRevision(c.drsDocument!);
    freeze(r, c);
    simulate(r, 'fixture', 'healthy');
    finalize(r);
    const assessment = assessDrs(r),
      metrics = renderDrsMetrics([c]);
    expect(metrics).toContain('finalized="true"');
    expect(metrics).toContain(`status="${assessment.status}"`);
    if (assessment.score !== null)
      expect(metrics).toMatch(
        new RegExp(`shieldtest_drs_score\\{[^\\n]+\\} ${assessment.score}(?:\\n|$)`),
      );
    for (const level of assessment.levels)
      expect(metrics).toContain(`level="${level.level}",coverage="total"} ${level.total}`);
  });
  it('isolates concurrent campaigns on the same target and preserves revision identity', () => {
    const a = fixture('one'),
      b = fixture('two');
    const metrics = renderDrsMetrics([a, b]);
    for (const c of [a, b]) {
      expect(metrics).toContain(`campaign_id="${c.id}"`);
      expect(metrics).toContain(`revision_id="${currentRevision(c.drsDocument!).id}"`);
    }
  });
  it('exposes failed plan integrity without dropping unrelated metrics or inventing a score', () => {
    const c = fixture(),
      r = currentRevision(c.drsDocument!);
    freeze(r, c);
    r.planHash = 'corrupted';
    const metrics = renderMetrics([c], 4);
    expect(metrics).toContain('shieldtest_runs_total 4');
    expect(metrics).toMatch(/shieldtest_drs_assessment_available\{[^\n]+\} 0/);
    expect(metrics).not.toContain('shieldtest_drs_score{');
    expect(metrics).not.toContain('shieldtest_drs_assessment_info{');
  });
});
