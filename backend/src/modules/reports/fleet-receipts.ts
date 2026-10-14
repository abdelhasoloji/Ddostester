import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { FLEET_LIMITS } from '../../config/limits.js';
import type { CampaignRun } from '../campaigns/runner.js';
export function reconcileFleetReceipts(run: CampaignRun, input: unknown, actor: string) {
  const fleet = run.generator.fleet;
  if (!fleet) throw new Error('Run has no Fleet evidence');
  if (
    !Number.isFinite(Date.parse(run.generator.startedAt)) ||
    !Number.isFinite(Date.parse(run.generator.finishedAt))
  )
    throw new Error('Generation window is unknown');
  const x = input as { origin?: unknown; confirmed?: unknown; records?: unknown[] };
  if (
    !x ||
    x.confirmed !== true ||
    typeof x.origin !== 'string' ||
    new URL(x.origin).origin !== new URL(run.generator.config.url).origin ||
    !Array.isArray(x.records) ||
    !x.records.length ||
    x.records.length > FLEET_LIMITS.maxRps * FLEET_LIMITS.maxDurationSec
  )
    throw new Error('Invalid target-log attestation or origin');
  const counts = new Map(
    fleet.shards.map((s) => [
      s.agentId,
      {
        agentId: s.agentId,
        receipts: 0,
        successful: 0,
        statusCounts: {} as Record<string, number>,
      },
    ]),
  );
  const sources = new Set<string>();
  const normalized = x.records.map((raw) => {
    const r = raw as { trace?: unknown; source?: unknown; status?: unknown; epochSec?: unknown };
    if (
      !r ||
      typeof r.trace !== 'string' ||
      r.trace.length > 512 ||
      typeof r.source !== 'string' ||
      !isIP(r.source) ||
      !Number.isInteger(r.status) ||
      Number(r.status) < 100 ||
      Number(r.status) > 599 ||
      typeof r.epochSec !== 'number' ||
      !Number.isFinite(r.epochSec)
    )
      throw new Error('Invalid receiver record');
    const [campaignId, runId, agentId, attemptId, ...extra] = r.trace.split(':');
    const shard = fleet.shards.find((s) => s.agentId === agentId && s.attemptId === attemptId);
    if (extra.length || campaignId !== run.campaignId || runId !== run.runId || !shard)
      throw new Error('Receiver record belongs to another assignment');
    if (
      r.epochSec * 1000 < Date.parse(run.generator.startedAt) - 2000 ||
      r.epochSec * 1000 > Date.parse(run.generator.finishedAt) + 2000
    )
      throw new Error('Receiver record is outside the generation window');
    const c = counts.get(agentId)!;
    c.receipts++;
    if (Number(r.status) >= 200 && Number(r.status) < 300) c.successful++;
    const status = String(r.status);
    c.statusCounts[status] = (c.statusCounts[status] ?? 0) + 1;
    sources.add(r.source);
    return { trace: r.trace, source: r.source, status: Number(r.status), epochSec: r.epochSec };
  });
  const agents = [...counts.values()].map((c) => {
    const g = fleet.shards.find((s) => s.agentId === c.agentId)?.result?.generator as
      { successful?: number; totalRequests?: number } | undefined;
    return {
      ...c,
      agentReportedSuccessful: g?.successful ?? null,
      agentReportedRequests: g?.totalRequests ?? null,
      matched: !!g && g.successful === c.successful && g.totalRequests === c.receipts,
    };
  });
  return {
    schema: 'ddostester.fleet.receiver/v1' as const,
    origin: new URL(x.origin).origin,
    recordedAt: new Date().toISOString(),
    recordedBy: actor,
    provenance: 'operator-imported-target-log' as const,
    sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    matched: agents.every((a) => a.matched),
    totalReceipts: normalized.length,
    successfulReceipts: agents.reduce((n, a) => n + a.successful, 0),
    sourceIps: [...sources].sort(),
    agents,
  };
}
export type FleetReceiverEvidence = ReturnType<typeof reconcileFleetReceipts>;
