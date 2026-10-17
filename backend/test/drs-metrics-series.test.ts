import { expect, it } from 'vitest';
import { resolveDrsSeries } from '../src/modules/metrics/series-catalog.js';
it('uses exact scoped labels and the Grafana freshness gate for Fleet participation', () => {
  const r = resolveDrsSeries('drs_agents', 'campaign', 'revision');
  expect(r?.lines).toHaveLength(2);
  for (const line of r!.lines) {
    expect(line.promql).toContain('campaign_id="campaign",revision_id="revision"');
    expect(line.promql).toContain('observed_timestamp_seconds');
    expect(line.promql).toContain('< 20');
    expect(line.promql).not.toContain('or vector(0)');
  }
});
it('rejects missing scope, raw PromQL and label injection', () => {
  for (const [n, c, r] of [
    ['drs_score', undefined, 'revision'],
    ['drs_score', 'campaign', undefined],
    ['drs_score', 'x"} or vector(1)', 'revision'],
    ['up', 'campaign', 'revision'],
  ])
    expect(resolveDrsSeries(n!, c, r)).toBeNull();
});
it('retains unknown coverage and never invents an aggregate family score', () => {
  const r = resolveDrsSeries('drs_coverage', 'c', 'r');
  expect(r?.lines.map((l) => l.label)).toEqual(['passed', 'failed', 'unknown']);
  expect(resolveDrsSeries('drs_score', 'c', 'r')?.lines[0].promql).toBe(
    'shieldtest_drs_score{campaign_id="c",revision_id="r"}',
  );
});
