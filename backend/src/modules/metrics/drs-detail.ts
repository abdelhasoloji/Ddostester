import type { Campaign } from '../campaigns/model.js';
import { DRS_MONITORING_LIMITS, FLEET_LIMITS } from '../../config/limits.js';

const escape = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const labels = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `${k}="${escape(v)}"`)
    .join(',');
const definition = (name: string, help: string) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n`;

/** Recorded workflow events survive missed scrapes; they are not physical exposure clocks. */
export function renderDrsTimeline(campaigns: Campaign[]): string {
  let output = definition(
    'shieldtest_drs_transition_timestamp_seconds',
    'Archived workflow transition time; mode distinguishes simulation from measurement',
  );
  output += definition(
    'shieldtest_drs_timeline_omitted_events',
    'Events not exported because of cardinality budget or invalid timestamps',
  );
  let emitted = 0,
    omitted = 0;
  for (const campaign of campaigns)
    for (const revision of campaign.drsDocument?.revisions ?? []) {
      for (const [index, event] of revision.trace.entries()) {
        const timestamp = Date.parse(event.at) / 1000;
        if (!Number.isFinite(timestamp) || emitted >= DRS_MONITORING_LIMITS.maxTimelineEvents) {
          omitted++;
          continue;
        }
        output += `shieldtest_drs_transition_timestamp_seconds{${labels({ campaign_id: campaign.id, revision_id: revision.id, mode: revision.plan.mode, event_index: String(index), state: event.state })}} ${timestamp}\n`;
        emitted++;
      }
    }
  return output + `shieldtest_drs_timeline_omitted_events ${omitted}\n`;
}

export interface FleetMonitoringMission {
  runId: string;
  campaignId: string;
  revisionId?: string;
  mode?: string;
  state: string;
  deadline: number;
  controlLeaseUntil: number;
  expectedAgents: number;
  shards: { agentId: string; state: string; leaseUntil: number; progressAt?: number }[];
}
/** A fresh report is evidence of reported execution, not proof of delivered traffic. */
export function summarizeFleetMonitoring(mission: FleetMonitoringMission, now: number) {
  const coherent =
    Number.isSafeInteger(mission.expectedAgents) &&
    mission.expectedAgents > 0 &&
    mission.expectedAgents <= FLEET_LIMITS.maxAgents &&
    mission.shards.length === mission.expectedAgents &&
    new Set(mission.shards.map((s) => s.agentId)).size === mission.expectedAgents;
  if (!coherent) return { reported: 0, unknown: mission.expectedAgents, complete: false };
  const parentFresh =
    mission.state === 'RUNNING' &&
    Number.isFinite(mission.deadline) &&
    mission.deadline > now &&
    Number.isFinite(mission.controlLeaseUntil) &&
    mission.controlLeaseUntil > now;
  let reported = 0,
    unknown = 0;
  for (const shard of mission.shards) {
    const fresh =
      parentFresh &&
      shard.state === 'RUNNING' &&
      Number.isFinite(shard.leaseUntil) &&
      shard.leaseUntil > now &&
      Number.isFinite(shard.progressAt) &&
      shard.progressAt! <= now &&
      now - shard.progressAt! <= DRS_MONITORING_LIMITS.maxProgressAgeMs;
    if (fresh) reported++;
    else if (
      !['SUCCEEDED', 'FAILED', 'STOPPED', 'LOST'].includes(shard.state) ||
      shard.leaseUntil > now
    )
      unknown++;
  }
  return { reported, unknown, complete: unknown === 0 };
}
export function renderFleetMonitoring(
  missions: FleetMonitoringMission[],
  now = Date.now(),
  omitted = 0,
): string {
  let output = '';
  for (const [suffix, help] of Object.entries({
    agents_reporting: 'Fresh agents reporting execution; incomplete coverage is a lower bound',
    agents_unknown: 'Agents whose present execution cannot be established',
    coverage_complete: 'All expected agent states accounted for; not delivered-load qualification',
    observed_timestamp_seconds: 'Exporter observation time, not agent freshness',
    omitted_missions: 'Missions omitted due to missing revision binding or cardinality budget',
  })) {
    output += definition('shieldtest_fleet_live_' + suffix, help);
  }
  for (const mission of missions.slice(0, DRS_MONITORING_LIMITS.maxFleetMissions)) {
    if (!mission.revisionId || !mission.mode || mission.mode === 'engine-validation') {
      omitted++;
      continue;
    }
    const revisionId = mission.revisionId;
    const mode = mission.mode;
    if (mission.state === 'SETTLED') continue;
    const value = summarizeFleetMonitoring(mission, now);
    const emit = (suffix: string, number: number) => {
      if (Number.isFinite(number))
        output += `shieldtest_fleet_live_${suffix}{${labels({ campaign_id: mission.campaignId, revision_id: revisionId, run_id: mission.runId, mode })}} ${number}\n`;
    };
    // Unknown or corrupt membership cannot become a plausible zero-agent campaign.
    if (
      Number.isSafeInteger(mission.expectedAgents) &&
      mission.expectedAgents > 0 &&
      mission.expectedAgents <= FLEET_LIMITS.maxAgents &&
      mission.shards.length === mission.expectedAgents &&
      new Set(mission.shards.map((s) => s.agentId)).size === mission.expectedAgents
    ) {
      emit('agents_reporting', value.reported);
      emit('agents_unknown', value.unknown);
    }
    emit('coverage_complete', Number(value.complete));
    emit('observed_timestamp_seconds', now / 1000);
  }
  omitted += Math.max(0, missions.length - DRS_MONITORING_LIMITS.maxFleetMissions);
  return output + `shieldtest_fleet_live_omitted_missions ${omitted}\n`;
}

export async function collectFleetMonitoring(
  database: Pick<import('pg').Pool, 'query'>,
  now = Date.now(),
): Promise<string> {
  const rows = await database.query(
    `WITH selected AS (
      SELECT id,data FROM fleet_missions_v1 WHERE data ? 'campaignId'
      ORDER BY data->>'createdAt' DESC,id DESC LIMIT $1
    ) SELECT m.id,m.data,r.state,r.deadline,r.control_lease_until,r.expected_agents,
      COALESCE(jsonb_agg(jsonb_build_object('agentId',s.agent_id,'state',s.state,
        'leaseUntil',s.assignment->'leaseUntil','progressAt',s.progress_at))
        FILTER (WHERE s.agent_id IS NOT NULL),'[]'::jsonb) AS shards
    FROM selected m LEFT JOIN fleet_runs_v1 r ON r.run_id=m.id
    LEFT JOIN fleet_shards_v1 s ON s.run_id=m.id
    GROUP BY m.id,m.data,r.state,r.deadline,r.control_lease_until,r.expected_agents
    ORDER BY m.data->>'createdAt' DESC,m.id DESC`,
    [DRS_MONITORING_LIMITS.maxFleetMissions + 1],
  );
  const missions: FleetMonitoringMission[] = rows.rows.map((row) => ({
    runId: row.id,
    campaignId: row.data.campaignId,
    revisionId: row.data.drsRevisionId,
    mode: row.data.drsMode,
    state: row.state,
    deadline: Number(row.deadline),
    controlLeaseUntil: Number(row.control_lease_until),
    expectedAgents: row.expected_agents,
    shards: row.shards.map((s: FleetMonitoringMission['shards'][number]) => ({
      ...s,
      progressAt: s.progressAt == null ? undefined : Number(s.progressAt),
    })),
  }));
  return renderFleetMonitoring(missions, now);
}
