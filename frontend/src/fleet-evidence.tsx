import type { CampaignRun, AgentGeneratorMeasurement } from './api.js';

/** Terminal evidence, not live agent health. Missing measurements stay explicit. */
export function FleetEvidencePanel({ run }: { run: CampaignRun }) {
  const fleet = run.generator.fleet;
  if (!fleet) return null;
  const leaseDate = (value: number) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
  };
  const number = (value: number | null | undefined, divisor: number, suffix: string) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${(value / divisor).toFixed(1)} ${suffix}`
      : 'unknown';
  return (
    <section aria-label="Fleet evidence">
      <h3>Fleet evidence</h3>
      <p className="hint">
        {fleet.measurementComplete
          ? 'All agents provided complete measurements.'
          : 'Incomplete measurement: missing or stopped agents prevent a complete resilience result.'}{' '}
        These are recorded terminal states, not current health.
        {!fleet.measurementComplete &&
          ' Generator counters include received final reports only; missing agents’ counters are unknown and target receipts remain independent evidence.'}
      </p>
      {fleet.startup && (
        <p className="hint">
          Generator-start timestamps cover {fleet.startup.reportedAgents}/
          {fleet.startup.expectedAgents} agents. Delay from parent start:{' '}
          {number(fleet.startup.firstGeneratorStartDelayMs, 1000, 's')} to{' '}
          {number(fleet.startup.lastGeneratorStartDelayMs, 1000, 's')}. These are not first-arrival
          timestamps; global throughput still includes startup.
        </p>
      )}
      <div
        className="fleet-table-scroll"
        role="region"
        aria-label="Fleet measurement table"
        tabIndex={0}
      >
        <table className="fleet-table">
          <caption>Private sources and generator resources</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">State</th>
              <th scope="col">Private IP</th>
              <th scope="col">Assigned budget</th>
              <th scope="col">RAM at finish</th>
              <th scope="col">CPU time</th>
              <th scope="col">Throttled time</th>
              <th scope="col">Requests / successful / failed</th>
              <th scope="col">Actual RPS</th>
              <th scope="col">p95 latency</th>
              <th scope="col">Cancelled requests</th>
            </tr>
          </thead>
          <tbody>
            {fleet.shards.map((shard) => {
              const resource = shard.result?.resources;
              const measurement = shard.result?.generator as AgentGeneratorMeasurement | undefined;
              return (
                <tr key={shard.agentId}>
                  <th scope="row">{shard.agentId}</th>
                  <td>{shard.state}</td>
                  <td>{shard.result?.podIp ?? 'unknown'}</td>
                  <td>
                    {shard.budget
                      ? `${shard.budget.maxRps} RPS · ${shard.budget.concurrency} concurrent · ${shard.budget.durationSec}s`
                      : 'unknown'}
                  </td>
                  <td>{number(resource?.processRssBytesAtFinish, 1024 * 1024, 'MiB')}</td>
                  <td>
                    {number(
                      resource
                        ? resource.processCpuUserUsec + resource.processCpuSystemUsec
                        : undefined,
                      1000,
                      'ms',
                    )}
                  </td>
                  <td>{number(resource?.cgroupThrottledUsecDelta, 1000, 'ms')}</td>
                  <td>
                    {measurement
                      ? `${measurement.totalRequests} / ${measurement.successful} / ${measurement.failed}`
                      : 'unknown'}
                  </td>
                  <td>{number(measurement?.actualRps, 1, 'RPS')}</td>
                  <td>{number(measurement?.latencyMs?.p95, 1, 'ms')}</td>
                  <td>
                    {shard.state === 'STOPPED' && measurement?.errors
                      ? (measurement.errors.AbortError ?? 0)
                      : 'not applicable'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Campaign probe: {run.probe?.available ?? 'unknown'}/{run.probe?.samples ?? 'unknown'}{' '}
        available observations, measured independently of agent counters. Failed counters retain
        cancelled requests. All VPS Lab agents share one public egress IP; private addresses
        identify pods.
      </p>
      {fleet.receiverEvidence && (
        <section aria-label="Target receiver evidence">
          <h4>Target receiver evidence</h4>
          <p>
            {fleet.receiverEvidence.matched
              ? 'Receiver counts match agent reports.'
              : 'Receiver and agent counts differ; review before drawing conclusions.'}{' '}
            {fleet.receiverEvidence.successfulReceipts} successful /{' '}
            {fleet.receiverEvidence.totalReceipts} received. Sources:{' '}
            {fleet.receiverEvidence.sourceIps.join(', ')}.
          </p>
          <p className="hint">
            {fleet.receiverEvidence.provenance}; recorded {fleet.receiverEvidence.recordedAt}.
            Imported logs are operator-attested, not independently authenticated by the application.
          </p>
        </section>
      )}
      <details className="fleet-identities">
        <summary>Identity and lease evidence</summary>
        <ul>
          {fleet.shards.map((shard) => (
            <li key={shard.agentId}>
              {shard.agentId}: pod {shard.result?.podUid ?? 'unknown'}; attempt {shard.attemptId};
              latest assignment hash {shard.assignmentHash ?? 'unknown'}; last recorded lease{' '}
              {leaseDate(shard.leaseUntil)}; outcome {shard.result?.reason ?? 'unknown'}.
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
