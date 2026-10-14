import { createHash } from 'node:crypto';
import { fleetCounterCoverage } from '../fleet/summary.js';
import type { CampaignRun } from '../campaigns/runner.js';
import type { LoadTestResult } from '../../engine/types.js';

export function fleetResourceMeasurements(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const resource = value as Record<string, unknown>;
  if (resource.schema !== 'ddostester.fleet.resources/v1') return null;
  const numeric = (key: string) =>
    typeof resource[key] === 'number' &&
    Number.isFinite(resource[key]) &&
    (resource[key] as number) >= 0
      ? resource[key]
      : null;
  return {
    schema: resource.schema,
    elapsedMs: numeric('elapsedMs'),
    processCpuUserUsec: numeric('processCpuUserUsec'),
    processCpuSystemUsec: numeric('processCpuSystemUsec'),
    processRssBytesAtFinish: numeric('processRssBytesAtFinish'),
    processPeakRssBytesLifetime: numeric('processPeakRssBytesLifetime'),
    cgroupThrottledUsecDelta: numeric('cgroupThrottledUsecDelta'),
    cgroupThrottledPeriodsDelta: numeric('cgroupThrottledPeriodsDelta'),
  };
}

export function fleetMeasurements(generator: LoadTestResult) {
  const {
    id,
    startedAt,
    finishedAt,
    totalRequests,
    successful,
    failed,
    statusCounts,
    errors,
    actualRps,
    latencyMs,
    latencyHistogram,
    latencyPolicy,
    hardStopped,
  } = generator;
  return {
    id,
    startedAt,
    finishedAt,
    totalRequests,
    successful,
    failed,
    statusCounts,
    errors,
    actualRps,
    latencyMs,
    latencyHistogram,
    latencyPolicy,
    hardStopped,
  };
}
/** Persisted evidence survives Job TTL. Headers, bodies and target queries are excluded. */
export function fleetEvidence(run: CampaignRun) {
  if (!run.generator.fleet) throw new Error('Run has no fleet evidence');
  const content = {
    schema: 'ddostester.fleet.evidence/v1',
    runId: run.runId,
    campaignId: run.campaignId,
    status: run.status,
    engine: run.engine,
    measurementWindow: {
      campaignId: run.campaignId,
      runId: run.runId,
      startedAt: run.generator.startedAt,
      finishedAt: run.generator.finishedAt,
      probeVantage: run.generator.config?.execution?.probeVantage ?? 'not recorded',
      scope: 'campaign-and-run-correlated',
      countersSource: 'agent-final-reports',
      receiverVerification:
        'not included; successful HTTP responses are not a server-log reconciliation',
    },
    generator: fleetMeasurements(run.generator),
    fleet: {
      startup: run.generator.fleet.startup,
      jobEvidence: run.generator.fleet.jobEvidence,
      measurementComplete: run.generator.fleet.measurementComplete,
      receiverEvidence: run.generator.fleet.receiverEvidence,
      counterCoverage:
        run.generator.fleet.counterCoverage ?? fleetCounterCoverage(run.generator.fleet.shards),
      shards: run.generator.fleet.shards.map((shard) => ({
        agentId: shard.agentId,
        state: shard.state,
        attemptId: shard.attemptId,
        leaseUntil: shard.leaseUntil,
        assignmentHash: shard.assignmentHash,
        budget: shard.budget,
        result: shard.result
          ? {
              state: shard.result.state,
              reason: shard.result.reason,
              claimedAssignmentHash: shard.result.claimedAssignmentHash,
              podUid: shard.result.podUid,
              podIp: shard.result.podIp,
              resources: fleetResourceMeasurements(shard.result.resources),
              generator: shard.result.generator
                ? fleetMeasurements(shard.result.generator as LoadTestResult)
                : undefined,
            }
          : undefined,
      })),
    },
    probe: run.probe,
    baseline: run.baseline,
    recoveryBeforeRun: run.recoveryBeforeRun,
    timeline: run.timeline,
    targetTelemetry: run.targetTelemetry,
    confidence: run.confidence,
    measurementPolicy: run.measurementPolicy,
    limitations: [
      'SHA-256 detects alteration but does not authenticate the exporter.',
      'Missing agent evidence remains missing.',
      'Job receipts contain selected identity, image and status fields and bounded log snapshots; full manifests and complete log history are not included.',
    ],
  };
  const serialized = JSON.stringify(content);
  return { content, sha256: createHash('sha256').update(serialized).digest('hex') };
}
