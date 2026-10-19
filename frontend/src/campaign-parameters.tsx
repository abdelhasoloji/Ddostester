import { useEffect, useState } from 'react';
import { api, type Campaign } from './api.js';
import { useApp } from './context.js';
import { Modal } from './modal.js';
import { HelpTip } from './interface-kit.js';

type Parameters = Awaited<ReturnType<typeof api.campaignParameters>>;
export function CampaignParameters({
  campaign,
  disabled = false,
}: {
  campaign: Campaign;
  disabled?: boolean;
}) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  if (
    !['APPROVED', 'PENDING_APPROVAL'].includes(campaign.status) ||
    campaign.runId ||
    campaign.archived ||
    campaign.drsDocument ||
    campaign.agent === 'fleet'
  )
    return null;
  if (app.authRequired && !app.capabilities.includes('campaign:create')) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        title={
          disabled
            ? 'Pause the sequence and wait for the active step or health check to finish.'
            : 'Edit this unstarted step; renewed approval or confirmation is required.'
        }
        onClick={() => setOpen(true)}
      >
        Parameters
      </button>
      {open && <ParameterDialog id={campaign.id} onClose={() => setOpen(false)} />}
    </>
  );
}
function ParameterDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const app = useApp();
  const [data, setData] = useState<Parameters>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .campaignParameters(id)
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  const edit = (key: 'maxRps' | 'concurrency' | 'maxDurationSec', value: string) =>
    setData((d) => d && { ...d, campaign: { ...d.campaign, [key]: Number(value) } });
  const phase = (index: number, key: 'maxRps' | 'durationSec', value: string) =>
    setData((d) => {
      if (!d) return d;
      const scenario = d.campaign.scenario!.map((p, i) =>
        i === index ? { ...p, [key]: Number(value) } : p,
      );
      return {
        ...d,
        campaign: {
          ...d.campaign,
          scenario,
          maxRps: Math.max(...scenario.map((p) => p.maxRps)),
          maxDurationSec: scenario.reduce((sum, p) => sum + p.durationSec, 0),
        },
      };
    });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      const c = data.campaign;
      await api.updateCampaignParameters(id, {
        revision: data.revision,
        maxRps: c.maxRps,
        concurrency: c.concurrency,
        maxDurationSec: c.maxDurationSec,
        scenario: c.scenario?.map(({ maxRps, durationSec }) => ({ maxRps, durationSec })),
      });
      await app.refresh();
      onClose();
      app.push('success', 'Parameters saved. Approval or confirmation required.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      label="Step parameters"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Step parameters</h2>
      {error && <p role="alert">{error}</p>}
      {data ? (
        <form className="parameter-form" onSubmit={save}>
          <p>{data.campaign.name}</p>
          <div className="parameter-fields">
            {!data.campaign.scenario && (
              <label>
                Rate ({data.campaign.vector === 'http-slowloris' ? 'connections/s' : 'req/s'})
                <input
                  type="number"
                  required
                  min={1}
                  max={data.limits.maxRps}
                  step={1}
                  value={data.campaign.maxRps}
                  onChange={(e) => edit('maxRps', e.target.value)}
                />
                <small>
                  1–{data.limits.maxRps}{' '}
                  {data.campaign.vector === 'http-slowloris' ? 'connections/s' : 'req/s'}
                </small>
              </label>
            )}
            <label>
              Concurrency
              <input
                type="number"
                required
                min={1}
                max={data.limits.maxConcurrency}
                step={1}
                value={data.campaign.concurrency}
                onChange={(e) => edit('concurrency', e.target.value)}
              />
              <small>1–{data.limits.maxConcurrency}</small>
            </label>
            {!data.campaign.scenario && (
              <label>
                Duration (s)
                <input
                  type="number"
                  required
                  min={1}
                  max={data.limits.maxDurationSec}
                  step={1}
                  value={data.campaign.maxDurationSec}
                  onChange={(e) => edit('maxDurationSec', e.target.value)}
                />
                <small>1–{data.limits.maxDurationSec} s</small>
              </label>
            )}
          </div>
          {data.campaign.scenario?.map((p, i) => (
            <fieldset className="parameter-fields parameter-phase" key={i}>
              <legend>Phase {i + 1}</legend>
              <label>
                Phase {i + 1} rate
                <input
                  type="number"
                  required
                  min={1}
                  max={data.limits.maxRps}
                  value={p.maxRps}
                  onChange={(e) => phase(i, 'maxRps', e.target.value)}
                />
              </label>
              <label>
                Phase {i + 1} duration
                <input
                  type="number"
                  required
                  min={1}
                  max={data.limits.maxDurationSec}
                  value={p.durationSec}
                  onChange={(e) => phase(i, 'durationSec', e.target.value)}
                />
              </label>
            </fieldset>
          ))}
          <p className="hint">
            Server limits apply.{' '}
            <HelpTip
              label="About parameter limits"
              text={`Bounds come from current operational limits and immutable ceilings. Built-in routing thresholds: ${data.builtin.rps} req/s / ${data.builtin.concurrency} concurrent (not a hardware capacity guarantee; not connection-hold limits). Actual capacity requires measurement. Target, engine and stop rules are preserved. Saving requires renewed approval or confirmation.`}
            />
          </p>
          {data.campaign.scenario && (
            <p className="hint">
              Total {data.campaign.maxDurationSec} / {data.limits.maxDurationSec} s · peak{' '}
              {data.campaign.maxRps} / {data.limits.maxRps} req/s
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || data.campaign.maxDurationSec > data.limits.maxDurationSec}
            >
              Save parameters
            </button>
          </div>
        </form>
      ) : (
        !error && <p>Loading parameters…</p>
      )}
    </Modal>
  );
}
