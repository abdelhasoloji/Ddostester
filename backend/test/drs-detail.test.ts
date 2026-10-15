import { describe, it, expect } from 'vitest';
import {
  renderDrsTimeline,
  renderFleetMonitoring,
  summarizeFleetMonitoring,
  type FleetMonitoringMission,
} from '../src/modules/metrics/drs-detail.js';
import { DRS_MONITORING_LIMITS } from '../src/config/limits.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
function mission(): FleetMonitoringMission {
  return {
    runId: 'run-one',
    campaignId: 'campaign',
    revisionId: 'revision',
    mode: 'synthetic-lab',
    state: 'RUNNING',
    deadline: 20000,
    controlLeaseUntil: 16000,
    expectedAgents: 3,
    shards: ['a', 'b', 'c'].map((agentId) => ({
      agentId,
      state: 'RUNNING',
      leaseUntil: 16000,
      progressAt: 9000,
    })),
  };
}
describe('Read-only DRS monitoring projections', () => {
  it('counts fresh execution reports, not inventory heartbeats', () => {
    expect(summarizeFleetMonitoring(mission(), 10000)).toEqual({
      reported: 3,
      unknown: 0,
      complete: true,
    });
    const m = mission();
    m.shards[0].progressAt = undefined;
    m.shards[1].progressAt = 0;
    expect(summarizeFleetMonitoring(m, 10000)).toEqual({
      reported: 1,
      unknown: 2,
      complete: false,
    });
  });
  it('does not retain a running count after lease expiry, control loss or future observations', () => {
    for (const change of [
      (m: FleetMonitoringMission) => (m.controlLeaseUntil = 9000),
      (m: FleetMonitoringMission) => (m.deadline = 9000),
      (m: FleetMonitoringMission) => {
        m.shards.forEach((s) => (s.progressAt = 11000));
      },
      (m: FleetMonitoringMission) => {
        m.shards.forEach((s) => (s.leaseUntil = 9000));
      },
    ]) {
      const m = mission();
      change(m);
      expect(summarizeFleetMonitoring(m, 10000)).toEqual({
        reported: 0,
        unknown: 3,
        complete: false,
      });
    }
  });
  it('does not fabricate zero agents when membership is corrupt or partial', () => {
    const m = mission();
    m.shards.pop();
    const text = renderFleetMonitoring([m], 10000);
    expect(text).not.toContain('shieldtest_fleet_live_agents_reporting{');
    expect(text).toMatch(/coverage_complete\{[^\n]+\} 0/);
    m.shards = [m.shards[0], m.shards[0], m.shards[0]];
    expect(renderFleetMonitoring([m], 10000)).not.toContain(
      'shieldtest_fleet_live_agents_reporting{',
    );
  });
  it('leaves legacy unbound missions and simulation counts absent', () => {
    for (const m of [
      { ...mission(), revisionId: undefined },
      { ...mission(), mode: 'engine-validation' },
    ]) {
      const text = renderFleetMonitoring([m], 10000);
      expect(text).not.toContain('shieldtest_fleet_live_agents_reporting{');
      expect(text).toContain('shieldtest_fleet_live_omitted_missions 1');
    }
  });
  it('exposes truncated history and preserves repeated phase events', () => {
    const trace = [
      { state: 'BASELINE', at: '2026-10-15T00:00:00Z', detail: '' },
      { state: 'BASELINE', at: '2026-10-15T00:01:00Z', detail: '' },
      { state: 'RECOVERY', at: 'invalid', detail: '' },
    ];
    const c = {
      id: 'one',
      drsDocument: { revisions: [{ id: 'revision', plan: { mode: 'engine-validation' }, trace }] },
    } as unknown as Campaign;
    let text = renderDrsTimeline([c]);
    expect(text).toContain('event_index="0"');
    expect(text).toContain('event_index="1"');
    expect(text).toContain('shieldtest_drs_timeline_omitted_events 1');
    trace.splice(
      0,
      trace.length,
      ...Array.from({ length: DRS_MONITORING_LIMITS.maxTimelineEvents + 2 }, () => ({
        state: 'BASELINE',
        at: '2026-10-15T00:00:00Z',
        detail: '',
      })),
    );
    text = renderDrsTimeline([c]);
    expect(text).toContain('shieldtest_drs_timeline_omitted_events 2');
    expect(text.match(/^shieldtest_drs_transition_timestamp_seconds\{/gm)).toHaveLength(
      DRS_MONITORING_LIMITS.maxTimelineEvents,
    );
  });
  it('caps mission cardinality and reports omitted records', () => {
    const missions = Array.from({ length: DRS_MONITORING_LIMITS.maxFleetMissions + 2 }, (_, i) => ({
      ...mission(),
      runId: 'run-' + i,
    }));
    const text = renderFleetMonitoring(missions, 10000);
    expect(text.match(/^shieldtest_fleet_live_agents_reporting\{/gm)).toHaveLength(
      DRS_MONITORING_LIMITS.maxFleetMissions,
    );
    expect(text).toContain('shieldtest_fleet_live_omitted_missions 2');
  });
  it('does not claim completion before a terminal agent lease has expired', () => {
    const m = mission();
    m.shards.forEach((s) => (s.state = 'STOPPED'));
    expect(summarizeFleetMonitoring(m, 10000)).toEqual({
      reported: 0,
      unknown: 3,
      complete: false,
    });
    m.shards.forEach((s) => (s.leaseUntil = 9000));
    expect(summarizeFleetMonitoring(m, 10000)).toEqual({ reported: 0, unknown: 0, complete: true });
  });
  it('never mutates the mission and omits settled runs from the live count', () => {
    const m = mission();
    const before = structuredClone(m);
    renderFleetMonitoring([m], 10000);
    expect(m).toEqual(before);
    m.state = 'SETTLED';
    expect(renderFleetMonitoring([m], 10000)).not.toContain(
      'shieldtest_fleet_live_agents_reporting{',
    );
  });
});
