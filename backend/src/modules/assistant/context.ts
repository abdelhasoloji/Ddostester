/** Only the target origin is admissible in model summaries, never URL credentials or payload paths. */
export function assistantTargetOrigin(raw: string): string {
  try {
    const target = new URL(raw);
    return ['http:', 'https:'].includes(target.protocol) ? target.origin : 'unknown';
  } catch {
    return 'unknown';
  }
}

interface MeasurementSummary {
  status: string;
  generator: { fleet?: { measurementComplete: boolean } };
  confidence?: { degraded: boolean };
  assessment?: { verdict: string };
  wrs?: { wrs: number; level: string; estimated?: boolean };
}
export function assistantLatestRun<
  T extends {
    campaignId: string;
    generator: { finishedAt?: string; startedAt?: string };
  },
>(runs: T[], campaignId: string): T | undefined {
  const candidates = runs.filter((run) => run.campaignId === campaignId);
  const timestamp = (run: T) =>
    Date.parse(run.generator.finishedAt ?? run.generator.startedAt ?? '');
  if (candidates.some((run) => !Number.isFinite(timestamp(run)))) return undefined;
  return candidates.sort((a, b) => timestamp(b) - timestamp(a))[0];
}
/** Missing or inconclusive evidence must not become a model-facing resilience score. */
export function assistantMeasurementSummary(run?: MeasurementSummary): string {
  if (!run) return 'measurement evidence unavailable; WRS withheld';
  if (run.generator.fleet?.measurementComplete === false)
    return 'fleet measurement incomplete; WRS withheld';
  if (run.status !== 'COMPLETED' || run.assessment?.verdict === 'inconclusive')
    return 'measurement inconclusive or interrupted; WRS withheld';
  if (run.confidence?.degraded) return 'measurement confidence degraded; WRS withheld';
  if (!run.wrs || !Number.isFinite(run.wrs.wrs) || run.wrs.wrs < 0 || run.wrs.wrs > 100)
    return 'WRS unavailable';
  return `${run.wrs.estimated ? 'Estimated WRS' : 'WRS'} ${run.wrs.wrs}`;
}
