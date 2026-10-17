import type { CampaignRun } from '../campaigns/runner.js';
import type { LoadTestResult } from '../../engine/types.js';
import { htmlEscape as esc } from '../../util/text.js';
import { fleetResourceMeasurements } from './fleet-evidence.js';
import { observedProbeP95 } from './measurements.js';
const metric = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? String(Math.round(value * 100) / 100)
    : 'unknown';
export function renderFleetMeasurementHtml(run: CampaignRun): string {
  const fleet = run.generator.fleet;
  if (!fleet) return '';
  const rows = fleet.shards
    .map((s) => {
      const g = s.result?.generator as Partial<LoadTestResult> | undefined;
      const cancelled = s.state === 'STOPPED' && g?.errors ? (g.errors.AbortError ?? 0) : undefined;
      const resource = fleetResourceMeasurements(s.result?.resources);
      return `<tr><td>${esc(s.agentId)}</td><td>${esc(s.state)}</td><td>${esc(String(s.result?.podIp ?? 'unknown'))}</td><td>${metric(s.budget?.maxRps)}</td><td>${metric(g?.actualRps)}</td><td>${metric(g?.totalRequests)}</td><td>${metric(g?.successful)}</td><td>${metric(g?.failed)}</td><td>${metric(cancelled)}</td><td>${metric(g?.latencyMs?.p95)}</td><td>${metric(resource?.cgroupThrottledUsecDelta === null || resource?.cgroupThrottledUsecDelta === undefined ? undefined : Number(resource.cgroupThrottledUsecDelta) / 1000)}</td></tr>`;
    })
    .join('');
  const receiver = fleet.receiverEvidence;
  const receiverHtml = receiver
    ? `<h3>Target receiver evidence</h3><p>${receiver.matched ? 'Receiver counts match agent reports.' : 'Receiver and agent counts differ.'} ${receiver.successfulReceipts}/${receiver.totalReceipts} successful receiver records. Source IPs: ${esc(receiver.sourceIps.join(', '))}. Provenance: ${esc(receiver.provenance)}. Recorded by ${esc(receiver.recordedBy)} at ${esc(receiver.recordedAt)}. These are operator-attested imported logs, not independently authenticated by the application.</p>`
    : '<p>Target server receipts have not been attached. Successful HTTP responses are not server-log reconciliation.</p>';
  return (
    receiverHtml +
    `<h2>Fleet measurements and independent probe</h2><p>Campaign ${esc(String(run.campaignId ?? 'not recorded'))} · run ${esc(String(run.runId ?? 'not recorded'))}. Generation window ${esc(String(run.generator.startedAt ?? 'not recorded'))} to ${esc(String(run.generator.finishedAt ?? 'not recorded'))}. Probe vantage: ${esc(run.generator.config?.execution?.probeVantage ?? 'not recorded')}.</p><p>Probe: ${metric(run.probe.available)}/${metric(run.probe.samples)} available observations; p95 ${metric(observedProbeP95(run))} ms. Probe measurements are independent of agent-reported counters. Baseline and probe belong to this campaign, not the latest network-bench verdict.</p><table><thead><tr><th>Agent</th><th>Final state</th><th>Private IP</th><th>Assigned RPS</th><th>Actual RPS</th><th>Requests</th><th>Successful</th><th>Failed</th><th>Cancelled</th><th>p95 ms</th><th>Throttled ms</th></tr></thead><tbody>${rows}</tbody></table><p>Failed counters include cancellation errors; cancelled requests are reported separately only for STOPPED agents with AbortError evidence. Unknown measurements stay unknown. Private pod identities do not imply distinct public source IPs. Global percentiles use merged histograms, never averaged agent percentiles. Measurement completeness: ${fleet.measurementComplete ? 'complete' : 'incomplete'}; capacity conclusions also require the report confidence checks.</p>`
  );
}
