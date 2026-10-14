import { describe, expect, it } from 'vitest';
import { renderFleetMetrics } from '../src/modules/metrics/prometheus.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
function run(at: string, overrides: Record<string, unknown> = {}): CampaignRun {
  return {
    runId: at,
    generator: {
      config: { url: 'http://user:secret@10.1.0.4:8080/private?token=secret' },
      finishedAt: at,
      totalRequests: 17,
      fleet: {
        measurementComplete: false,
        counterCoverage: {
          scope: 'received-final-results-only',
          reportedAgents: 1,
          expectedAgents: 3,
        },
        shards: [{ result: { generator: {} } }, {}, {}],
        ...overrides,
      },
    },
  } as unknown as CampaignRun;
}
describe('persisted fleet Prometheus evidence', () => {
  it('exposes incomplete coverage and received subset without credentials or run labels', () => {
    const text = renderFleetMetrics([run('2026-10-14T00:00:00Z')]);
    expect(text).toContain(
      'shieldtest_fleet_measurement_complete_last{target="http://10.1.0.4:8080"} 0',
    );
    expect(text).toContain(
      'shieldtest_fleet_reported_agents_last{target="http://10.1.0.4:8080"} 1',
    );
    expect(text).toContain(
      'shieldtest_fleet_expected_agents_last{target="http://10.1.0.4:8080"} 3',
    );
    expect(text).toContain(
      'shieldtest_fleet_reported_requests_last{target="http://10.1.0.4:8080"} 17',
    );
    expect(text).not.toContain('secret');
    expect(text).not.toContain('runId');
    expect(text).not.toContain('/private');
  });
  it('chooses latest finish regardless of storage order and does not fill gaps from an older run', () => {
    const text = renderFleetMetrics([
      run('2026-10-13T00:00:00Z', { measurementComplete: true }),
      run('2026-10-14T00:00:00Z', { counterCoverage: undefined }),
    ]);
    expect(text).toContain('shieldtest_fleet_coverage_known_last{target="http://10.1.0.4:8080"} 0');
    expect(text).not.toMatch(/\nshieldtest_fleet_reported_agents_last\{/);
    expect(text).not.toMatch(/\nshieldtest_fleet_expected_agents_last\{/);
    expect(text).toContain(
      'shieldtest_fleet_measurement_complete_last{target="http://10.1.0.4:8080"} 0',
    );
  });
  it('rejects contradictory coverage without inventing zero reports', () => {
    const text = renderFleetMetrics([
      run('2026-10-14T00:00:00Z', {
        counterCoverage: {
          scope: 'received-final-results-only',
          reportedAgents: 2,
          expectedAgents: 3,
        },
      }),
    ]);
    expect(text).toContain('shieldtest_fleet_coverage_known_last{target="http://10.1.0.4:8080"} 0');
    expect(text).not.toMatch(/\nshieldtest_fleet_reported_agents_last\{/);
  });
  it('does not expose a run without a valid finished timestamp', () => {
    expect(renderFleetMetrics([run('invalid')])).not.toMatch(/\nshieldtest_fleet_\w+_last\{/);
  });
});
