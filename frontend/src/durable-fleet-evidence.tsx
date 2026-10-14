import { useState } from 'react';
import { api, type DurableFleetEvidence } from './api.js';

export function DurableFleetEvidencePanel({ campaignId }: { campaignId: string }) {
  const [evidence, setEvidence] = useState<DurableFleetEvidence | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError('');
    setEvidence(null);
    try {
      const next = await api.fleetEvidenceForCampaign(campaignId);
      if (
        next.content.schema !== 'ddostester.fleet.persisted-evidence/v1' ||
        next.content.campaignId !== campaignId
      )
        throw new Error('Evidence does not match this campaign');
      setEvidence(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evidence unavailable');
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!evidence) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recorded-fleet-evidence.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section aria-label="Recorded fleet evidence">
      <h3>Recorded fleet evidence</h3>
      <p className="hint">
        No finalized campaign report is available. Recorded agent results may remain available.
        Missing probe history and resilience scores are not reconstructed.
      </p>
      <button className="btn btn-sm" disabled={busy} onClick={() => void load()}>
        {busy ? 'Loading…' : 'Read recorded evidence'}
      </button>
      {error && <p role="alert">{error}</p>}
      {evidence && (
        <>
          <p>
            {evidence.content.state} · {evidence.content.counterCoverage.reportedAgents}/
            {evidence.content.counterCoverage.expectedAgents ?? 'unknown'} final agent reports · WRS
            unavailable
          </p>
          <ul>
            {evidence.content.shards.map((shard) => (
              <li key={shard.agentId}>
                {shard.agentId}: {shard.state} · source {shard.result?.podIp ?? 'unknown'} ·
                reported requests {shard.result?.generator?.totalRequests ?? 'unknown'}
              </li>
            ))}
          </ul>
          <p className="hint">
            Snapshot of recorded coordination, not a finalized campaign report or proof of process
            termination.
          </p>
          <button className="btn btn-sm" onClick={download}>
            Download recorded evidence
          </button>
        </>
      )}
    </section>
  );
}
