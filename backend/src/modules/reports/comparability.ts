import { isDeepStrictEqual } from 'node:util';
import type { CampaignRun } from '../campaigns/runner.js';

/** Observational equivalence of recorded workloads; never a causal proof. */
export function runComparability(a: CampaignRun, b: CampaignRun) {
  const reasons: string[] = [];
  for (const [label, run] of [
    ['before', a],
    ['after', b],
  ] as const) {
    if ((run.generator.unfinalizedRequests ?? 0) > 0)
      reasons.push(`${label}: HTTP outcomes unfinalized`);
    const config = run.generator.config;
    if (!config || !config.execution) reasons.push(`${label}: execution context missing`);
    else {
      if (!config.execution.runtime) reasons.push(`${label}: runtime version missing`);
      if (!/^(?:[a-f0-9]{40}|snapshot:[a-f0-9]{64})$/.test(config.execution.sourceRef))
        reasons.push(`${label}: source identity unknown`);
      if (config.execution.engine !== 'builtin-http')
        reasons.push(`${label}: external/fleet engine version conformance not recorded`);
    }
    if (
      !run.confidence ||
      run.confidence.degraded ||
      !run.assessment ||
      run.assessment.verdict === 'inconclusive'
    )
      reasons.push(`${label}: measurement confidence unknown or degraded`);
    if (run.wrs.estimated || !Number.isFinite(run.wrs.wrs) || run.wrs.wrs < 0 || run.wrs.wrs > 100)
      reasons.push(`${label}: score estimated or invalid`);
    if (!['COMPLETED', 'KILLED_AUTO'].includes(run.status))
      reasons.push(`${label}: run interrupted or unfinished`);
    if (
      run.probe.samples <= 0 ||
      !Number.isFinite(run.probe.samples) ||
      !Number.isFinite(run.probe.available) ||
      run.probe.available < 0 ||
      run.probe.available > run.probe.samples
    )
      reasons.push(`${label}: probe observations missing`);
    if (run.generator.fleet && !run.generator.fleet.measurementComplete)
      reasons.push(`${label}: fleet final measurements incomplete`);
    if (run.baseline?.observation?.complete === false || run.recoveryBeforeRun?.verified === false)
      reasons.push(`${label}: baseline or preceding recovery unverified`);
  }
  const signature = (run: CampaignRun) => {
    const config = run.generator.config;
    if (!config) return null;
    const { requestPermit: _permit, ...snapshot } = config;
    return {
      ...snapshot,
      headers: Object.fromEntries(
        Object.entries(config.headers ?? {}).filter(
          ([name]) => name.toLowerCase() !== 'x-wedos-test',
        ),
      ),
    };
  };
  if (!isDeepStrictEqual(signature(a), signature(b)))
    reasons.push('recorded workload or execution context differs');
  return {
    schema: 'ddostester.run-comparability/v1' as const,
    comparable: reasons.length === 0,
    reasons,
  };
}
