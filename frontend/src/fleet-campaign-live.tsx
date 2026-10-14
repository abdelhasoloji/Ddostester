import { useEffect, useState } from 'react';
import { api, type FleetCampaignObservation } from './api.js';
export function FleetCampaignLive({
  campaignId,
  expectedCount,
}: {
  campaignId: string;
  expectedCount?: number;
}) {
  const [data, setData] = useState<FleetCampaignObservation>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.fleetCampaign(campaignId);
        if (value.campaignId !== campaignId) throw new Error('Fleet campaign mismatch');
        if (live) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(() => void poll(), 1000);
      }
    };
    setData(undefined);
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [campaignId]);
  const shards = error ? undefined : data?.mission?.snapshot?.shards;
  const total = data?.mission?.snapshot?.shards.length ?? expectedCount;
  const active = shards?.filter((s) => s.state === 'RUNNING').length;
  return (
    <div className="fleet-live-count" aria-label="Fleet bot counter">
      <span className={`fleet-live-dot${active ? ' is-active' : ''}`} aria-hidden="true" />
      <span role="status" aria-live="polite" aria-atomic="true">
        <strong>{active ?? '—'}</strong> bots active{' '}
        <span className="muted">
          of {total ?? '—'} {shards ? 'assigned' : 'selected'}
        </span>
      </span>
      {error && (
        <span className="hint" role="alert">
          Live count unavailable
        </span>
      )}
    </div>
  );
}
