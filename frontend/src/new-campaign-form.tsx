import { useEffect, useState } from 'react';
import { useApp, canDo } from './context.js';
import { PRESETS, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';
import {
  buildAcceptance,
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
  const [form, setForm] = useState({ ...emptyForm, ...initial });
  const [attested, setAttested] = useState(false);
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);

  // Apply a preset's load shape (rate/concurrency/duration/profile) and its
  // recommended engine when installed — never the target — keeping whatever the
  // operator already typed for name/target/probe.
  const applyPreset = (p: Preset) => {
    const recAvailable = app.agents.some((a) => a.id === p.recommendedAgent && a.available);
    setForm((f) => ({
      ...f,
      name: f.name.trim() || p.name,
      maxRps: p.maxRps,
      concurrency: p.concurrency,
      maxDurationSec: p.maxDurationSec,
      profile: p.profile,
      agent: recAvailable ? p.recommendedAgent : f.agent,
    }));
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

  // Consume a preset queued from another page (e.g. the Guide).
  const { draftPreset, clearDraftPreset } = app;
  useEffect(() => {
    if (draftPreset) {
      applyPreset(draftPreset);
      clearDraftPreset();
    }
  }, [draftPreset]);

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
      profile: a && !a.multiPhase && f.profile !== 'constant' ? 'constant' : f.profile,
    }));
    setAppliedPreset(null);
  };

  const targetAllowed = (() => {
    const h = hostOf(form.target);
    return h !== null && app.allowed.includes(h);
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
    form.maxDurationSec <= caps.maxDurationSec;
  const identityOk = app.authRequired ? app.identity !== null : app.operator.trim() !== '';
  const canCreate = canDo(app.role, 'create', app.authRequired);
  const formValid =
    form.name.trim() !== '' &&
    identityOk &&
    targetAllowed &&
    probeAllowed &&
    referenceAllowed &&
    capsOk &&
    attested &&
    canCreate;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formValid) return;
    try {
      await app.createCampaign({
        name: form.name,
        target: form.target,
        probeUrl: form.probeUrl,
        referenceUrl: form.referenceUrl.trim() || undefined,
        vector: form.vector,
        body: form.vector === 'http-post' ? form.body : undefined,
        maxRps: Number(form.maxRps),
        concurrency: Number(form.concurrency),
        maxDurationSec: Number(form.maxDurationSec),
        cacheBust: form.cacheBust || undefined,
        noKeepAlive: form.noKeepAlive || undefined,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        scenario: buildScenario(form.profile, Number(form.maxRps), Number(form.maxDurationSec)),
        agent: form.agent || undefined,
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
    <section className="card">
      <div className="card-head">
        <h2>New campaign</h2>
        {onDone && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
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
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label>Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Vector</label>
          <select
            value={form.vector}
            onChange={(e) => setForm({ ...form, vector: e.target.value })}
          >
            <option value="http-get">http-get</option>
            <option value="http-post">http-post</option>
          </select>
        </div>
        <div className="field">
          <label>Target (URL)</label>
          <input
            className={form.target && !targetAllowed ? 'invalid' : ''}
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
          <label>Probe (URL)</label>
          <input
            className={form.probeUrl && !probeAllowed ? 'invalid' : ''}
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
          <label>Reference vantage (URL, optional)</label>
          <input
            className={form.referenceUrl && !referenceAllowed ? 'invalid' : ''}
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
        <div className="field">
          <label>Max RPS</label>
          <input
            type="number"
            value={form.maxRps}
            onChange={(e) => {
              setForm({ ...form, maxRps: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">cap {caps.maxRps}</span>
        </div>
        <div className="field">
          <label>Concurrency</label>
          <input
            type="number"
            value={form.concurrency}
            onChange={(e) => {
              setForm({ ...form, concurrency: Number(e.target.value) });
              setAppliedPreset(null);
            }}
          />
          <span className="hint">1–{caps.maxConcurrency}</span>
        </div>
        <div className="field">
          <label>Max duration (s)</label>
          <input
            type="number"
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
        <details className="form-section" open style={{ gridColumn: '1 / -1' }}>
          <summary>Load shape &amp; scheduling</summary>
          <div className="grid">
            <div className="field">
              <label>Load profile</label>
              <select
                value={form.profile}
                onChange={(e) => {
                  setForm({ ...form, profile: e.target.value });
                  setAppliedPreset(null);
                }}
              >
                <option value="constant">Constant</option>
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
              <label>Load engine</label>
              <select value={form.agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">Server default ({app.agentName || 'builtin-http'})</option>
                {app.agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.available}>
                    {a.name}
                    {a.available ? '' : ' — not installed'}
                    {a.multiPhase ? '' : ' (constant only)'}
                  </option>
                ))}
              </select>
              {selectedAgent && <span className="hint">{selectedAgent.description}</span>}
            </div>
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
          </div>
        </details>
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
          Submit for approval
        </button>
      </form>
    </section>
  );
}
