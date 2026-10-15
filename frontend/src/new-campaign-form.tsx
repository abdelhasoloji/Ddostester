import { useEffect, useState } from 'react';
import { useApp, canDo } from './context.js';
import { PRESETS, estimatedRequests, formatCount } from './presets.js';
import { api, type FleetDevice } from './api.js';
import type { Preset } from './presets.js';
import {
  buildAcceptance,
  buildIoTProfile,
  buildAssertion,
  buildScenario,
  emptyForm,
  hostOf,
  parseDataset,
  parseEndpoints,
  parseFlow,
  parseFlowJson,
} from './campaign-form.js';

export function NewCampaignForm({
  onDone,
  initial,
}: {
  onDone?: () => void;
  /** Seed values (e.g. carried over from the guided wizard's "Advanced" step). */
  initial?: Partial<typeof emptyForm>;
}) {
  const app = useApp();
  // The server's HARD_CAPS (single source of truth), delivered via /health and
  // read from context — never hardcoded here, so the form's hints and the
  // server's enforcement can never drift. Used only for inline hints; the
  // backend enforces the caps regardless.
  const caps = app.hardCaps;
  const [form, setForm] = useState({
    ...emptyForm,
    ...(app.agentName?.includes('fleet') && initial?.agent === undefined
      ? { agent: 'builtin' }
      : {}),
    ...initial,
  });
  const [fleetDevices, setFleetDevices] = useState<FleetDevice[]>([]);
  const [fleetError, setFleetError] = useState('');
  const [generatorChanged, setGeneratorChanged] = useState(false);
  const [fleetOrigins, setFleetOrigins] = useState<string[]>([]);
  const [fleetSite, setFleetSite] = useState('');
  const [fleetPage, setFleetPage] = useState(1);
  const [fleetTotal, setFleetTotal] = useState(0);
  const [fleetSites, setFleetSites] = useState<{ id: string; devices: number; online: number }[]>(
    [],
  );
  const [fleetVisible, setFleetVisible] = useState<string[]>([]);
  const [fleetPolicyCaps, setFleetPolicyCaps] = useState<{
    maxRps: number;
    maxConcurrency: number;
    maxDurationSec: number;
  }>();
  useEffect(() => {
    if (form.agent !== 'fleet') return;
    let live = true;
    void (async () => {
      try {
        const result = await api.fleetOverview();
        if (!Array.isArray(result.devices) || !Array.isArray(result.origins))
          throw new Error('Fleet policy unavailable');
        if (!live) return;
        let devices: FleetDevice[] = result.devices.filter((d) => d.group === 'VPS Lab');
        if (app.drsWorkflow) {
          const [page, sites] = await Promise.all([
            api.fleetDevices({ page: fleetPage, pageSize: 100, siteId: fleetSite }),
            api.fleetSites(),
          ]);
          if (!live) return;
          devices = page.devices;
          setFleetTotal(page.total ?? devices.length);
          setFleetSites(sites.sites);
          setFleetVisible(devices.map((d) => d.id));
        }
        setFleetDevices((old) =>
          app.drsWorkflow
            ? [...new Map([...old, ...devices].map((d) => [d.id, d])).values()]
            : devices,
        );
        setFleetOrigins(result.origins);
        setFleetPolicyCaps(result.caps);
        setFleetError('');
        setForm((f) =>
          f.fleetDeviceIds.length
            ? f
            : {
                ...f,
                fleetDeviceIds: devices
                  .filter(
                    (d) => d.connection === 'online' && d.agentVersion === 'fleet-mission-agent/v1',
                  )
                  .slice(0, 3)
                  .map((d) => d.id),
              },
        );
      } catch (e) {
        if (live) setFleetError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [form.agent, app.drsWorkflow, fleetSite, fleetPage]);
  const [attested, setAttested] = useState(false);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  // Apply a preset's load shape (rate/concurrency/duration/profile) and its
  // recommended engine when installed — never the target — keeping whatever the
  // operator already typed for name/target/probe.
  const applyPreset = (p: Preset) => {
    const recAvailable = app.agents.some((a) => a.id === p.recommendedAgent && a.available);
    setForm((f) => {
      // Update the name to the new preset's UNLESS the operator typed their own.
      // The name is "preset-owned" (and so replaceable) when it is blank or still
      // equals the previously applied preset's name — otherwise switching presets
      // used to leave the first preset's name stuck in the field.
      const prevPreset = PRESETS.find((x) => x.id === appliedPreset);
      const nameIsPresetOwned = !f.name.trim() || f.name.trim() === prevPreset?.name;
      return {
        ...f,
        name: nameIsPresetOwned ? p.name : f.name,
        maxRps: p.maxRps,
        concurrency: p.concurrency,
        maxDurationSec: p.maxDurationSec,
        profile: p.profile,
        agent: recAvailable ? p.recommendedAgent : f.agent,
      };
    });
    setAppliedPreset(p.id);
  };

  // Swap the host of a URL, preserving protocol/port/path (falls back to a
  // bare http URL if the current value can't be parsed).
  const withHost = (current: string, host: string): string => {
    try {
      const u = new URL(current);
      u.hostname = host;
      return u.toString();
    } catch {
      return `http://${host}/`;
    }
  };

  // A preset queued from the Guide is turned into an `initial` seed by
  // CampaignLaunch and arrives through the same prop as recon/replay seeds — so
  // there is no in-form draftPreset effect to consume (and self-clear) here.

  // Selected load engine (empty = server default) and its multi-phase support.
  const selectedAgent = app.agents.find((a) => a.id === form.agent);
  const multiPhaseOk = !selectedAgent || selectedAgent.multiPhase;
  // Flow editor only when the selected engine (or the default builtin) can run
  // multi-step flows.
  const flowSupported = selectedAgent ? selectedAgent.flowCapable : true;
  // Response assertions are evaluated by the built-in engine only.
  const assertionSupported = form.agent === '' || form.agent === 'builtin';
  const targetOrigin = (() => {
    try {
      return new URL(form.target).origin;
    } catch {
      return '';
    }
  })();
  // Switching to a constant-only engine resets a ramp/wave profile.
  const setAgent = (id: string) => {
    const a = app.agents.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      agent: id,
      fleetDeviceIds: id === 'fleet' ? f.fleetDeviceIds : [],
      ...(id === 'fleet'
        ? {
            vector: 'http-get' as const,
            maxRps: f.maxRps,
            concurrency: f.concurrency,
            maxDurationSec: f.maxDurationSec,
            endpoints: '',
            flow: '',
            body: '',
            copiedHeaders: {},
            iotProfile: '',
            cacheBust: false,
            noKeepAlive: false,
            calibrate: false,
            scheduledAt: '',
            recurrenceMin: '',
            userAgents: '',
            dataset: '',
            assertStatus: '',
            assertBody: '',
            parallelism: 1,
            copiedScenario: [],
            profile: 'constant',
          }
        : {}),
      profile: id === 'fleet' || (a && !a.multiPhase) ? 'constant' : f.profile,
    }));
    setAppliedPreset(null);
    setGeneratorChanged(true);
  };

  const targetAllowed = (() => {
    const h = hostOf(form.target);
    return (
      h !== null &&
      app.allowed.includes(h) &&
      (form.agent !== 'fleet' || fleetOrigins.includes(new URL(form.target).origin))
    );
  })();
  const probeAllowed = (() => {
    const h = hostOf(form.probeUrl);
    return h !== null && app.allowed.includes(h);
  })();
  // Reference vantage is optional; when set it must be an allowlisted host too.
  const referenceAllowed = (() => {
    if (!form.referenceUrl.trim()) return true;
    const h = hostOf(form.referenceUrl);
    return h !== null && app.allowed.includes(h);
  })();
  const capsOk =
    form.maxRps > 0 &&
    form.maxRps <= caps.maxRps &&
    form.concurrency >= 1 &&
    form.concurrency <= caps.maxConcurrency &&
    form.maxDurationSec >= 1 &&
    form.maxDurationSec <= caps.maxDurationSec &&
    (form.agent !== 'fleet' ||
      (form.fleetDeviceIds.length >= 1 &&
        form.fleetDeviceIds.length <= 3 &&
        !fleetError &&
        form.fleetDeviceIds.every((id) =>
          fleetDevices.some(
            (d) =>
              d.id === id &&
              d.connection === 'online' &&
              d.agentVersion === 'fleet-mission-agent/v1',
          ),
        ) &&
        form.maxRps >= form.fleetDeviceIds.length &&
        form.maxRps <= 15 &&
        form.concurrency >= form.fleetDeviceIds.length &&
        form.concurrency <= 6 &&
        form.maxDurationSec >= 10 &&
        form.maxDurationSec <= 60));
  const identityOk = app.authRequired ? app.identity !== null : app.operator.trim() !== '';
  const canCreate = canDo(app.role, 'create', app.authRequired, app.userMode, app.capabilities);
  const iotValid = (() => {
    if (!form.iotProfile) return true;
    try {
      buildIoTProfile(form);
      return (
        form.agent === 'builtin' &&
        form.vector === 'http-post' &&
        new URL(form.probeUrl).origin === targetOrigin &&
        !form.body &&
        !form.flow &&
        !form.endpoints &&
        !form.dataset &&
        !form.cacheBust
      );
    } catch {
      return false;
    }
  })();
  const fleetCompatible =
    form.agent !== 'fleet' ||
    (form.vector === 'http-get' &&
      form.profile === 'constant' &&
      !form.body &&
      !form.flow &&
      !form.endpoints &&
      !form.iotProfile &&
      !form.dataset &&
      !form.userAgents &&
      !form.assertStatus &&
      !form.assertBody &&
      !form.cacheBust &&
      !form.noKeepAlive &&
      !form.calibrate &&
      form.parallelism === 1 &&
      !form.scheduledAt &&
      !form.recurrenceMin &&
      Object.keys(form.copiedHeaders).length === 0);
  const formValid =
    form.name.trim() !== '' &&
    identityOk &&
    targetAllowed &&
    probeAllowed &&
    referenceAllowed &&
    capsOk &&
    (!app.drsWorkflow ||
      (form.agent === 'fleet' &&
        /^(cra-l7-get-flood|drs-3\.00\.00-[1-7]51002)$/.test(form.drsProfileId))) &&
    fleetCompatible &&
    iotValid &&
    attested &&
    canCreate;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid) return;
    try {
      await app.createCampaign({
        drsProfileId: form.drsProfileId || undefined,
        drsMode: app.drsWorkflow
          ? (form.drsMode as 'engine-validation' | 'synthetic-lab' | 'measured')
          : undefined,
        name: form.name,
        target: form.target,
        probeUrl: form.probeUrl,
        referenceUrl: form.referenceUrl.trim() || undefined,
        probeVantage: form.probeVantage === 'remote' ? 'remote' : undefined,
        vector: form.vector,
        body: form.vector === 'http-post' ? form.body : undefined,
        headers: Object.keys(form.copiedHeaders).length ? form.copiedHeaders : undefined,
        maxRps: Number(form.maxRps),
        concurrency: Number(form.concurrency),
        maxDurationSec: Number(form.maxDurationSec),
        cacheBust: form.cacheBust || undefined,
        noKeepAlive: form.noKeepAlive || undefined,
        parallelism: Number(form.parallelism) > 1 ? Number(form.parallelism) : undefined,
        calibrate: form.calibrate || undefined,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        scenario:
          form.profile === 'copied'
            ? form.copiedScenario
            : buildScenario(form.profile, Number(form.maxRps), Number(form.maxDurationSec)),
        agent: form.agent || undefined,
        fleetDeviceIds: form.agent === 'fleet' ? form.fleetDeviceIds : undefined,
        iotProfile: buildIoTProfile(form),
        recurrence: form.recurrenceMin ? { intervalMin: Number(form.recurrenceMin) } : undefined,
        flow:
          flowSupported && form.flow.trim()
            ? form.flowAdvanced
              ? parseFlowJson(form.flow)
              : parseFlow(form.flow, targetOrigin)
            : undefined,
        acceptance: buildAcceptance(form),
        assertion: assertionSupported ? buildAssertion(form) : undefined,
        endpoints:
          assertionSupported && form.endpoints.trim() ? parseEndpoints(form.endpoints) : undefined,
        userAgents:
          assertionSupported && form.userAgents.trim()
            ? form.userAgents
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
            : undefined,
        dataset: assertionSupported && form.dataset.trim() ? parseDataset(form.dataset) : undefined,
        authorized: true,
      });
      setForm({ ...emptyForm });
      setAttested(false);
      onDone?.();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };

  if (!canCreate) return null;
  return (
    <section className="card campaign-form">
      <div className="card-head">
        <div className="card-head-title">
          <span className="form-eyebrow">◎ Campaign editor</span>
          <h2>New campaign</h2>
        </div>
        {onDone && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      {!fleetCompatible && (
        <p role="alert">
          Fleet supports a single constant GET without advanced local options or scheduling. Review
          the configuration or choose Local generator.
        </p>
      )}
      {app.drsWorkflow && (
        <label>
          Campaign mode
          <select
            value={form.drsMode}
            onChange={(e) => setForm({ ...form, drsMode: e.target.value })}
          >
            <option value="engine-validation">Engine validation · simulated events only</option>
            <option value="synthetic-lab">Synthetic laboratory · experimental measurement</option>
            <option value="measured">Measured evaluation · independent evidence required</option>
          </select>
          <span className="hint">
            After creation, configure and freeze the plan in DRS assessment. Mode changes create a
            new revision.
          </span>
        </label>
      )}
      {app.drsWorkflow && (
        <p className="hint">
          Referenced DRS profile: {form.drsProfileId}. Fleet execution only; explicit confirmation
          required.
        </p>
      )}
      {!app.drsWorkflow && (
        <div className="presets-row">
          <span className="presets-label">Start from a preset:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip${appliedPreset === p.id ? ' chip-active' : ''}`}
              title={p.when}
              onClick={() => applyPreset(p)}
            >
              <span aria-hidden="true">{p.icon}</span> {p.name}
            </button>
          ))}
        </div>
      )}
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="campaign-name">Name</label>
          <input
            id="campaign-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="campaign-vector">Vector</label>
          <select
            id="campaign-vector"
            value={form.vector}
            onChange={(e) => setForm({ ...form, vector: e.target.value })}
          >
            <option value="http-get">http-get</option>
            <option value="http-post" disabled={form.agent === 'fleet'}>
              http-post
            </option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="campaign-target">Target (URL)</label>
          <input
            className={form.target && !targetAllowed ? 'invalid' : ''}
            id="campaign-target"
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
          />
          {app.allowed.length > 0 && (
            <div className="allowed-chips">
              <span className="hint">Allowed hosts:</span>
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip chip-xs"
                  title={`Use ${h} (keeps port/path)`}
                  onClick={() => setForm((f) => ({ ...f, target: withHost(f.target, h) }))}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {form.target && !targetAllowed && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Host not in allowlist — will be rejected.
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="campaign-probe">Probe (URL)</label>
          <input
            className={form.probeUrl && !probeAllowed ? 'invalid' : ''}
            id="campaign-probe"
            value={form.probeUrl}
            onChange={(e) => setForm({ ...form, probeUrl: e.target.value })}
          />
          {app.allowed.length > 0 && (
            <div className="allowed-chips">
              <span className="hint">Allowed hosts:</span>
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="chip chip-xs"
                  title={`Use ${h} (keeps port/path)`}
                  onClick={() => setForm((f) => ({ ...f, probeUrl: withHost(f.probeUrl, h) }))}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {form.probeUrl && !probeAllowed && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Host not in allowlist — will be rejected.
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="campaign-reference">Reference vantage (URL, optional)</label>
          <input
            className={form.referenceUrl && !referenceAllowed ? 'invalid' : ''}
            id="campaign-reference"
            value={form.referenceUrl}
            placeholder="independent canary — e.g. a known-good health URL"
            onChange={(e) => setForm({ ...form, referenceUrl: e.target.value })}
          />
          <span className="hint">
            Polled alongside the probe with no kill authority. If the target degrades while this
            stays up, the outage is attributed to the target; if both fall together, the run is
            flagged inconclusive.
          </span>
          {form.referenceUrl && !referenceAllowed && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Host not in allowlist — will be rejected.
            </span>
          )}
        </div>
        {app.remoteProbe && (
          <div className="field">
            <label>Probe vantage</label>
            <select
              value={form.probeVantage}
              onChange={(e) => setForm({ ...form, probeVantage: e.target.value })}
            >
              <option value="local">Local (control plane / VPS1)</option>
              <option value="remote">Remote agent (VPS2, tailnet)</option>
            </select>
            <span className="hint">
              Where the availability probe is measured from. Pick <b>Remote</b> when the target
              rate-limits by source IP (e.g. one connection per IP), so the probe uses a different
              source IP than the load generator instead of colliding with it.
            </span>
          </div>
        )}
        <div className="field">
          <label htmlFor="campaign-rps">Max RPS</label>
          <input
            type="number"
            id="campaign-rps"
            value={form.maxRps}
            onChange={(e) => {
              setForm({ ...form, maxRps: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">
            Shared cap{' '}
            {form.agent === 'fleet' ? (fleetPolicyCaps?.maxRps ?? 'loading') : caps.maxRps}{' '}
            requests/s
          </span>
        </div>
        <div className="field">
          <label htmlFor="campaign-concurrency">Concurrency</label>
          <input
            type="number"
            id="campaign-concurrency"
            value={form.concurrency}
            onChange={(e) => {
              setForm({ ...form, concurrency: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">
            1–
            {form.agent === 'fleet'
              ? (fleetPolicyCaps?.maxConcurrency ?? 'loading')
              : caps.maxConcurrency}{' '}
            concurrent requests, shared across agents
          </span>
        </div>
        <div className="field">
          <label htmlFor="campaign-duration">Max duration (s)</label>
          <input
            type="number"
            id="campaign-duration"
            value={form.maxDurationSec}
            onChange={(e) => {
              setForm({ ...form, maxDurationSec: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">≤ {caps.maxDurationSec}s (15 min)</span>
        </div>
        {(() => {
          // Config-time delivery hint (E13): predict whether this rate/concurrency
          // will actually be delivered — by the built-in engine, an auto-routed
          // out-of-process engine, or not at all (built-in-only features pin it
          // to the built-in engine, which can't be routed away).
          const bc = app.builtinCeilings;
          const overRate = form.maxRps > bc.rps;
          const overConc = form.concurrency > bc.concurrency;
          if (!overRate && !overConc) return null;
          const why = overRate
            ? `${form.maxRps} rps is above the built-in engine's ~${bc.rps} rps ceiling`
            : `${form.concurrency} concurrent requests exceed the built-in engine's ${bc.concurrency} in-process limit`;
          // Already on an external engine → it delivers the full rate, no hint.
          if (selectedAgent && selectedAgent.id !== 'builtin') return null;
          // Built-in-only features keep the step on the built-in engine: it can
          // NOT auto-route away, so at this rate it will genuinely under-deliver.
          const builtinOnly =
            !!form.userAgents.trim() || !!form.dataset.trim() || !!buildAssertion(form);
          if (builtinOnly) {
            return (
              <p className="hint engine-hint warn" style={{ gridColumn: '1 / -1' }}>
                ⚠ {why} — but UA rotation / dataset / assertion are built-in-engine-only, so this
                step can’t route to Vegeta/k6 and will under-deliver (~{bc.rps} rps). Lower the rate
                and concurrency, or drop those features to let it run out-of-process.
              </p>
            );
          }
          return (
            <p className="hint engine-hint" style={{ gridColumn: '1 / -1' }}>
              ⚙ {why}. This step auto-routes to an out-of-process engine (Vegeta/k6) so it delivers
              the full load without stalling the measurement loop. <b>If neither is installed</b>,
              the built-in engine caps around {bc.rps} rps and this step will under-deliver.
            </p>
          );
        })()}
        <label className="cachebust-toggle" style={{ gridColumn: '1 / -1' }}>
          <input
            type="checkbox"
            checked={form.cacheBust}
            onChange={(e) => {
              setForm({ ...form, cacheBust: e.target.checked });
              setAppliedPreset(null);
            }}
          />{' '}
          Cache-busting — append a unique <code>?_cb=</code> to every request so an edge/CDN or page
          cache can’t serve it. Forces each request through to the origin (defeats LiteSpeed/CDN
          caching of a GET flood). Works on built-in, k6 and vegeta.
        </label>
        <label className="cachebust-toggle" style={{ gridColumn: '1 / -1' }}>
          <input
            type="checkbox"
            checked={form.noKeepAlive}
            onChange={(e) => {
              setForm({ ...form, noKeepAlive: e.target.checked });
              setAppliedPreset(null);
            }}
          />{' '}
          No keep-alive — open a fresh connection for every request instead of reusing one.
          Pressures the origin’s connection-accept path (handshake / accept queue) that a keep-alive
          flood never touches. Works on built-in, k6 and vegeta.
        </label>
        <label className="cachebust-toggle" style={{ gridColumn: '1 / -1' }}>
          Parallel generation (vegeta):{' '}
          <input
            type="number"
            min={1}
            max={8}
            style={{ width: '4rem' }}
            value={form.parallelism}
            onChange={(e) => {
              setForm({ ...form, parallelism: Math.max(1, Math.min(8, Number(e.target.value))) });
              setAppliedPreset(null);
            }}
          />{' '}
          concurrent workers, each at <code>rate ÷ N</code> — spreads the load over more processes
          on the host to push past a single vegeta’s throughput ceiling. Total rate unchanged. 1 =
          single process.
        </label>
        <label className="cachebust-toggle" style={{ gridColumn: '1 / -1' }}>
          <input
            type="checkbox"
            checked={form.calibrate}
            onChange={(e) => {
              setForm({ ...form, calibrate: e.target.checked });
              setAppliedPreset(null);
            }}
          />{' '}
          Auto-calibrate rate — fire a short pre-flight burst to measure the rate this box can
          actually deliver against the target, then grade at that rate instead of an aspirational
          one the box can’t sustain (which the report then marks inconclusive). Only ever lowers the
          offered rate; the applied vs requested rate is shown on the run. Best for high-rate
          composite / pulse lines.
        </label>
        <details className="form-section" open style={{ gridColumn: '1 / -1' }}>
          <summary>Load shape &amp; scheduling</summary>
          <div className="grid">
            <div className="field">
              <label htmlFor="campaign-profile">Load profile</label>
              {form.profile === 'copied' && (
                <p className="hint">
                  Original phases retained: {JSON.stringify(form.copiedScenario)}. Choose Constant,
                  Ramp-up or Waves to replace them.
                </p>
              )}
              {Object.keys(form.copiedHeaders).length > 0 && (
                <p className="hint">
                  Copied request headers retained: {Object.keys(form.copiedHeaders).join(', ')}.
                </p>
              )}
              <select
                id="campaign-profile"
                value={form.profile}
                onChange={(e) => {
                  setForm({ ...form, profile: e.target.value });
                  setAppliedPreset(null);
                }}
              >
                <option value="constant">Constant</option>
                {form.copiedScenario.length > 0 && (
                  <option value="copied" disabled={!multiPhaseOk}>
                    Copied scenario (original phases)
                  </option>
                )}
                <option value="ramp" disabled={!multiPhaseOk}>
                  Ramp-up (25→50→100%)
                </option>
                <option value="wave" disabled={!multiPhaseOk}>
                  Waves (100→20→100%)
                </option>
              </select>
              {!multiPhaseOk && (
                <span className="hint">{selectedAgent?.name} runs a constant rate only.</span>
              )}
            </div>
            <div className="field">
              <label htmlFor="campaign-generator">Generator</label>
              <select
                disabled={app.drsWorkflow}
                id="campaign-generator"
                value={form.agent === 'fleet' ? 'fleet' : 'local'}
                onChange={(e) => setAgent(e.target.value === 'fleet' ? 'fleet' : 'builtin')}
              >
                <option value="local">Local generator</option>
                <option
                  value="fleet"
                  disabled={!app.agents.some((a) => a.id === 'fleet' && a.available)}
                >
                  IoT Fleet
                </option>
              </select>
              <p className="hint">
                Both modes generate simulated HTTP traffic. The target, independent probe,
                confirmation, stop control and report use the same campaign workflow.
              </p>
              {generatorChanged && (
                <p role="status" className="hint">
                  Generator changed. Review the scenario and total budget before creating this
                  campaign. Fleet uses bounded constant GET; incompatible options are cleared.
                </p>
              )}
              {form.agent !== 'fleet' && (
                <details>
                  <summary>Advanced local engine</summary>
                  <label htmlFor="campaign-local-engine">Local engine</label>
                  <select
                    id="campaign-local-engine"
                    value={form.agent}
                    onChange={(e) => setAgent(e.target.value)}
                  >
                    {!app.agentName?.includes('fleet') && (
                      <option value="">Server default ({app.agentName || 'builtin-http'})</option>
                    )}
                    {app.agents
                      .filter((a) => a.id !== 'fleet')
                      .map((a) => (
                        <option key={a.id} value={a.id} disabled={!a.available}>
                          {a.name}
                          {a.available ? '' : ' — not installed'}
                          {a.multiPhase ? '' : ' (constant only)'}
                        </option>
                      ))}
                  </select>
                </details>
              )}
              {selectedAgent && <span className="hint">{selectedAgent.description}</span>}
              {form.agent === 'fleet' && (
                <p className="hint">
                  Uses the selected VPS Lab bots and the campaign target/probe URLs. This increment
                  supports a single GET; choosing Fleet resets unsupported load options. The total
                  budget is shared, not multiplied per bot. Your existing budget is retained for
                  review.
                  {fleetPolicyCaps &&
                    ` Fleet ceilings: ${fleetPolicyCaps.maxRps} requests/s total, ${fleetPolicyCaps.maxConcurrency} concurrent requests, ${fleetPolicyCaps.maxDurationSec}s.`}
                </p>
              )}
              {form.agent === 'fleet' && (
                <p className="hint">
                  Fleet target origins: {fleetOrigins.join(', ') || 'none available'}. Application
                  allowlisting alone does not enable an origin for agents.
                </p>
              )}
              {form.agent === 'fleet' && (
                <fieldset>
                  <legend>Campaign agents — select one to three</legend>
                  {fleetError && <p role="alert">Inventory unavailable: {fleetError}</p>}
                  {app.drsWorkflow && (
                    <div className="fleet-toolbar">
                      <label>
                        Site{' '}
                        <select
                          value={fleetSite}
                          onChange={(e) => {
                            setFleetSite(e.target.value);
                            setFleetPage(1);
                          }}
                        >
                          <option value="">All sites</option>
                          {fleetSites.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.id} · {s.online}/{s.devices} online
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={fleetPage === 1}
                        onClick={() => setFleetPage((p) => p - 1)}
                      >
                        Previous agents
                      </button>
                      <span>
                        Page {fleetPage} · {fleetTotal} agents · {form.fleetDeviceIds.length}{' '}
                        selected
                      </span>
                      <button
                        type="button"
                        disabled={fleetPage * 100 >= fleetTotal}
                        onClick={() => setFleetPage((p) => p + 1)}
                      >
                        Next agents
                      </button>
                    </div>
                  )}
                  {fleetDevices
                    .filter((d) => !app.drsWorkflow || fleetVisible.includes(d.id))
                    .map((d) => (
                      <label key={d.id}>
                        <input
                          type="checkbox"
                          aria-label={`Use ${d.name}`}
                          checked={form.fleetDeviceIds.includes(d.id)}
                          disabled={
                            d.connection !== 'online' || d.agentVersion !== 'fleet-mission-agent/v1'
                          }
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              fleetDeviceIds: e.target.checked
                                ? [...f.fleetDeviceIds, d.id]
                                : f.fleetDeviceIds.filter((id) => id !== d.id),
                            }))
                          }
                        />{' '}
                        {d.name} — {d.siteId ?? 'vps-lab'} · {d.privateIp} · {d.connection}
                      </label>
                    ))}
                </fieldset>
              )}
            </div>
            {app.approvalPolicy !== 'confirmation' && (
              <>
                <div className="field">
                  <label>Schedule (optional)</label>
                  <input
                    type="datetime-local"
                    value={form.scheduledAt}
                    onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                  />
                  <span className="hint">auto-run once approved</span>
                </div>
                <div className="field">
                  <label>Repeat every (optional)</label>
                  <select
                    value={form.recurrenceMin}
                    onChange={(e) => setForm({ ...form, recurrenceMin: e.target.value })}
                  >
                    <option value="">No repeat (single run)</option>
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="180">3 hours</option>
                    <option value="360">6 hours</option>
                    <option value="720">12 hours</option>
                  </select>
                  <span className="hint">re-runs within the 24 h approval window</span>
                </div>
              </>
            )}
          </div>
        </details>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="iot-profile">Synthetic device journey</label>
          <select
            id="iot-profile"
            value={form.iotProfile}
            onChange={(e) => {
              const id = e.target.value;
              setForm({
                ...form,
                iotProfile: id,
                ...(id ? { agent: 'builtin', vector: 'http-post' } : {}),
              });
              setAppliedPreset(null);
            }}
          >
            <option value="">Custom HTTP campaign</option>
            <option value="sensor-heartbeat/v1">Sensor heartbeat v1 (builtin)</option>
          </select>
          {form.iotProfile && (
            <>
              <label htmlFor="iot-seed">Reproducibility seed</label>
              <input
                id="iot-seed"
                type="number"
                min="0"
                max="4294967295"
                step="1"
                value={form.iotSeed}
                onChange={(e) => setForm({ ...form, iotSeed: e.target.value })}
              />
              <label htmlFor="iot-device">Device index</label>
              <input
                id="iot-device"
                type="number"
                min="0"
                max="999"
                step="1"
                value={form.iotDeviceIndex}
                onChange={(e) => setForm({ ...form, iotDeviceIndex: e.target.value })}
              />
              <span className="hint">
                Health GET, then a small telemetry POST with deterministic pauses. Target and probe
                must share an origin. Budgets remain unchanged.
              </span>
              {!iotValid && (
                <span role="alert">
                  Use builtin / HTTP POST, valid seed and index, matching origins, and clear custom
                  body, flow, endpoints, dataset and cache-busting.
                </span>
              )}
            </>
          )}
        </div>
        {form.vector === 'http-post' && (
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Request body (POST)</label>
            <textarea
              rows={3}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </div>
        )}
        <details className="form-section" style={{ gridColumn: '1 / -1' }}>
          <summary>Advanced realism &amp; acceptance (SLO)</summary>
          <div className="grid">
            {flowSupported ? (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>
                  Request flow — L7 journey (optional)
                  <label className="hint" style={{ marginLeft: '.75rem', fontWeight: 400 }}>
                    <input
                      type="checkbox"
                      checked={form.flowAdvanced}
                      onChange={(e) => setForm({ ...form, flowAdvanced: e.target.checked })}
                    />{' '}
                    Advanced (JSON: headers + correlation)
                  </label>
                </label>
                <textarea
                  rows={form.flowAdvanced ? 8 : 4}
                  placeholder={
                    form.flowAdvanced
                      ? `[\n  {"method":"POST","url":"${targetOrigin || 'http://host'}/login","extract":{"name":"token","from":"json","expr":"token"}},\n  {"method":"GET","url":"${targetOrigin || 'http://host'}/me","headers":{"Authorization":"Bearer {{token}}"}}\n]`
                      : 'GET /\nPOST /login 500\nGET /dashboard\nGET /logout'
                  }
                  value={form.flow}
                  onChange={(e) => setForm({ ...form, flow: e.target.value })}
                  style={{ fontFamily: 'var(--mono, monospace)' }}
                />
                <span className="hint">
                  {form.flowAdvanced ? (
                    <>
                      JSON array of steps (
                      <code>method, url, body?, headers?, thinkMs?, extract?</code>
                      ). Correlation: <code>extract</code> a value (json/header/regex) and reuse it
                      as <code>{'{{name}}'}</code> in later steps — needs the built-in engine.
                    </>
                  ) : (
                    <>
                      One step per line: <code>METHOD /path [thinkMs]</code>. Each step hits the
                      target host (allowlisted); the rate cap still bounds total req/s.
                    </>
                  )}
                </span>
              </div>
            ) : (
              form.agent && (
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <span className="hint">
                    Engine <b>{selectedAgent?.name}</b> doesn&apos;t support multi-step flows —
                    choose builtin/k6/jmeter/gatling/locust to define an L7 journey.
                  </span>
                </div>
              )
            )}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Acceptance criteria — SLO pass/fail (optional)</label>
              <div className="slo-grid">
                <input
                  type="number"
                  placeholder="max p95 ms"
                  value={form.sloP95}
                  onChange={(e) => setForm({ ...form, sloP95: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="max errors %"
                  value={form.sloErr}
                  onChange={(e) => setForm({ ...form, sloErr: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="min avail %"
                  value={form.sloAvail}
                  onChange={(e) => setForm({ ...form, sloAvail: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="min WRS"
                  value={form.sloWrs}
                  onChange={(e) => setForm({ ...form, sloWrs: e.target.value })}
                />
                {assertionSupported && (
                  <input
                    type="number"
                    placeholder="max assertion fail %"
                    value={form.sloAssert}
                    onChange={(e) => setForm({ ...form, sloAssert: e.target.value })}
                  />
                )}
              </div>
              <span className="hint">
                Leave blank to skip. Each run gets a <b>PASS/FAIL</b> verdict against the criteria
                you set.
              </span>
            </div>
            {assertionSupported && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Response assertion — validate each response (optional)</label>
                <div className="slo-grid">
                  <input
                    type="number"
                    placeholder="expected status"
                    value={form.assertStatus}
                    onChange={(e) => setForm({ ...form, assertStatus: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="body contains…"
                    value={form.assertBody}
                    onChange={(e) => setForm({ ...form, assertBody: e.target.value })}
                  />
                </div>
                <span className="hint">
                  Built-in engine only. Every response is checked; the failure rate feeds the SLO
                  verdict above.
                </span>
              </div>
            )}
            {assertionSupported && !form.flow.trim() && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Endpoint mix — spread load over several URLs (optional)</label>
                <textarea
                  rows={3}
                  placeholder={`One per line: [METHOD] url [weight]\nhttp://127.0.0.1:8080/ 3\nhttp://127.0.0.1:8080/health 1`}
                  value={form.endpoints}
                  onChange={(e) => setForm({ ...form, endpoints: e.target.value })}
                />
                <span className="hint">
                  Built-in engine only. Each request picks one endpoint by weight (default 1). More
                  realistic than a single URL. Mutually exclusive with a flow.
                </span>
              </div>
            )}
            {assertionSupported && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>User-Agent rotation — client diversity (optional)</label>
                <textarea
                  rows={3}
                  placeholder={`One User-Agent per line — each request picks one at random\nMozilla/5.0 (Windows NT 10.0; Win64; x64) …\nMozilla/5.0 (iPhone; CPU iPhone OS 17_0 …) …`}
                  value={form.userAgents}
                  onChange={(e) => setForm({ ...form, userAgents: e.target.value })}
                />
                <span className="hint">
                  Built-in engine only. Models realistic client diversity to test signature-based
                  mitigation. A benign header change — no attack mechanic.
                </span>
              </div>
            )}
            {assertionSupported && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Data feeder — parameterized traffic (optional)</label>
                <textarea
                  rows={3}
                  placeholder={`CSV: header line then rows. Reference columns as {{col}} in URL/body.\nq,id\napple,101\nbanana,102`}
                  value={form.dataset}
                  onChange={(e) => setForm({ ...form, dataset: e.target.value })}
                />
                <span className="hint">
                  Built-in engine only. Each request picks a row; <code>{'{{col}}'}</code> is
                  substituted into the URL, body and headers — realistic, varied traffic.
                </span>
              </div>
            )}
          </div>
        </details>
        <label className="attest">
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
          />
          <span>
            I attest that I own the target or hold a <b>written authorization</b> to test it
            (internal WEDOS / authorized scope).
          </span>
        </label>
        {capsOk && (
          <p className="estimate">
            ≈{' '}
            <b>{formatCount(estimatedRequests(form.maxRps, form.maxDurationSec, form.profile))}</b>{' '}
            requests over {form.maxDurationSec}s, peak {form.maxRps} rps · {form.concurrency}{' '}
            concurrent. Bounded HTTP — kill switch stays available.
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={!formValid}>
          {app.approvalPolicy === 'confirmation' ? 'Create campaign' : 'Submit for approval'}
        </button>
      </form>
    </section>
  );
}
