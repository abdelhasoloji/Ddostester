import { useState } from 'react';
import { useApp } from './context.js';
import { defaultTargetUrl } from './target-url.js';
import { api } from './api.js';
import type { ReconReport } from './api.js';
import { hostOf, emptyForm } from './campaign-form.js';
import { NewCampaignForm } from './new-campaign-form.js';
import { ReconDetailModal } from './recon-detail.js';

/**
 * E15 — the ONE recon-first way to create a campaign. The operator gives a
 * target; recon runs FIRST; the tool proposes a config seeded from what recon
 * found (dynamic endpoints, login → POST, cache → cache-busting, posture); then
 * the operator composes from a pre-filled form. Replaces the scattered
 * wizard/templates/plan entry points as the primary Launch surface.
 */

interface Suggestion {
  initial: Partial<typeof emptyForm>;
  rationale: string[];
}

/** Derives a suggested campaign config from a recon report, with the reasons. */
export function suggestFromRecon(recon: ReconReport): Suggestion {
  const rationale: string[] = [];
  let origin = recon.target;
  try {
    origin = new URL(recon.target).origin;
  } catch {
    /* keep raw */
  }
  const dyn = recon.dynamicPaths ?? [];
  const seedPaths = (
    dyn.length ? dyn : (recon.suggestedPaths ?? []).filter((p) => p !== '/')
  ).slice(0, 10);
  const endpoints = seedPaths.map((p) => `${origin}${p}`).join('\n');
  if (seedPaths.length) {
    rationale.push(
      `${seedPaths.length} ${dyn.length ? 'dynamic ⚡ ' : ''}path(s) seeded as the endpoint mix — the flood hits the real surface, not just the root.`,
    );
  }

  const hasLogin = !!recon.loginPath;
  const vector = hasLogin ? 'http-post' : 'http-get';
  if (hasLogin) {
    rationale.push(
      `A login/account path was found (${recon.loginPath}) → POST vector, to pressure the dynamic auth backend that a cache can't absorb.`,
    );
  }

  const cached = recon.profile?.cache === 'hit';
  const cacheBust = cached;
  if (cached) {
    rationale.push(
      `The target serves responses from cache → cache-busting ON so every request reaches the origin, not the cache.`,
    );
  }

  const p = recon.profile?.posture;
  if (p?.server)
    rationale.push(
      `Server: ${p.server}${p.rateLimiting ? ' · rate-limiting seen' : ''}${p.waf ? ' · WAF' : ''}${p.cdn ? ' · CDN' : ''}.`,
    );
  if (recon.baseline?.latencyP95) {
    rationale.push(
      `Baseline p95 ${Math.round(recon.baseline.latencyP95)}ms, ${Math.round(recon.baseline.availabilityPct)}% available — the reference to measure impact against.`,
    );
  }
  if (rationale.length === 0) {
    rationale.push(
      'Recon found no published surface — a bare-root flood is proposed; adjust below.',
    );
  }

  return {
    initial: {
      target: recon.target,
      probeUrl: recon.target,
      vector,
      endpoints,
      cacheBust,
    },
    rationale,
  };
}

/** A small, realistic client-diversity set used when UA rotation is enabled. */
export const DEFAULT_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

export type LeverId = 'cacheBust' | 'calibrate' | 'rotateUa' | 'noKeepAlive';

export interface LeverChoice {
  id: LeverId;
  label: string;
  /** The recon signal that recommends this lever, or null when it is optional. */
  signal: string | null;
  /** Pre-checked when recon recommends it. */
  recommended: boolean;
  /** Plain-language reason, shown under the toggle. */
  why: string;
}

/**
 * Turns each recon signal into a delivery lever the operator can accept or drop
 * with one click BEFORE launching — so the recon actually drives the run instead
 * of being read-only advice. A lever with a `signal` is pre-checked (recon
 * recommends it); optional levers start off. Pure, so it is unit-tested.
 */
export function deriveLevers(recon: ReconReport): LeverChoice[] {
  const p = recon.profile?.posture ?? {};
  const cached = recon.profile?.cache === 'hit';
  return [
    {
      id: 'cacheBust',
      label: 'Cache-busting',
      signal: cached ? 'CDN cache · HIT' : p.cdn ? 'CDN detected' : null,
      recommended: !!(cached || p.cdn),
      why: 'Adds a unique token per request so the edge/CDN cache can’t serve a stored copy — every request reaches the origin, not the cache.',
    },
    {
      id: 'calibrate',
      label: 'Auto-calibrate rate',
      signal: p.rateLimiting ? 'rate-limiter seen' : null,
      recommended: !!p.rateLimiting,
      why: 'A rate-limiter fronts the target — measure the deliverable rate first and grade at it, so the verdict is valid instead of a false inconclusive.',
    },
    {
      id: 'rotateUa',
      label: 'User-Agent rotation',
      signal: p.waf ? 'WAF detected' : null,
      recommended: !!p.waf,
      why: 'The WAF inspects client fingerprints — rotating User-Agents exercises signature-based filtering.',
    },
    {
      id: 'noKeepAlive',
      label: 'No keep-alive',
      signal: null,
      recommended: false,
      why: 'Optional: a fresh connection per request pressures the connection-accept / handshake path a keep-alive flood never touches.',
    },
  ];
}

/** A path recon found on the target's surface, flagged if it's a dynamic ⚡ one. */
export interface DiscoveredPath {
  path: string;
  dynamic: boolean;
}

/** The distinct surface recon found, dynamic (best stress targets) listed first. */
export function discoveredPaths(recon: ReconReport): DiscoveredPath[] {
  const dyn = new Set(recon.dynamicPaths ?? []);
  const all = [...(recon.suggestedPaths ?? []), ...(recon.dynamicPaths ?? [])].filter(
    (p) => p && p !== '/',
  );
  const seen = new Set<string>();
  const list: DiscoveredPath[] = [];
  for (const p of all) {
    if (!seen.has(p)) {
      seen.add(p);
      list.push({ path: p, dynamic: dyn.has(p) });
    }
  }
  return list.sort((a, b) => Number(b.dynamic) - Number(a.dynamic));
}

/** The paths pre-selected on arrival — the same set the tool used to auto-seed:
 *  the dynamic ⚡ ones when present, else the non-root suggested paths (max 10). */
export function defaultSelectedPaths(recon: ReconReport): string[] {
  const dyn = recon.dynamicPaths ?? [];
  return (dyn.length ? dyn : (recon.suggestedPaths ?? []).filter((p) => p !== '/')).slice(0, 10);
}

/** Build the endpoint-mix textarea value from the operator's selected paths. */
export function endpointsFromPaths(recon: ReconReport, selected: Iterable<string>): string {
  let origin = recon.target;
  try {
    origin = new URL(recon.target).origin;
  } catch {
    /* keep raw */
  }
  return [...selected].map((p) => `${origin}${p}`).join('\n');
}

/** Merge the toggled levers into the form seed (base config + lever booleans). */
export function applyLevers(
  base: Partial<typeof emptyForm>,
  on: Record<LeverId, boolean>,
): Partial<typeof emptyForm> {
  return {
    ...base,
    cacheBust: on.cacheBust,
    calibrate: on.calibrate,
    noKeepAlive: on.noKeepAlive,
    userAgents: on.rotateUa ? DEFAULT_UAS.join('\n') : '',
  };
}

export function ReconFirstCreate({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<'target' | 'recon' | 'compose'>('target');
  const [recon, setRecon] = useState<ReconReport | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [leverOn, setLeverOn] = useState<Record<LeverId, boolean>>({
    cacheBust: false,
    calibrate: false,
    rotateUa: false,
    noKeepAlive: false,
  });
  // Which recon-discovered paths the operator has chosen to hit.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showIntel, setShowIntel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const host = hostOf(target);
  const allowed = host !== null && app.allowed.includes(host);

  const runRecon = async () => {
    if (!allowed) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.recon(target);
      setRecon(r);
      setSuggestion(suggestFromRecon(r));
      // Pre-check the levers recon recommends; the operator adjusts before launch.
      setLeverOn(
        Object.fromEntries(deriveLevers(r).map((l) => [l.id, l.recommended])) as Record<
          LeverId,
          boolean
        >,
      );
      // Pre-select the discovered paths the tool would have auto-seeded.
      setSelectedPaths(new Set(defaultSelectedPaths(r)));
      setPhase('recon');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'compose' && suggestion) {
    return (
      <div>
        <div className="recon-first-back">
          <button className="btn btn-sm btn-ghost" onClick={() => setPhase('recon')}>
            ← Back to recon
          </button>
          <span className="hint">
            Composing against <code>{host}</code> — fields pre-filled from recon; adjust anything.
          </span>
        </div>
        <NewCampaignForm
          initial={applyLevers(
            recon
              ? { ...suggestion.initial, endpoints: endpointsFromPaths(recon, selectedPaths) }
              : suggestion.initial,
            leverOn,
          )}
          onDone={onDone}
        />
      </div>
    );
  }

  if (phase === 'recon' && recon && suggestion) {
    const p = recon.profile?.posture;
    const edge = [
      ['WAF', p?.waf],
      ['CDN', p?.cdn],
      ['Rate-limit', p?.rateLimiting],
    ] as const;
    return (
      <div className="recon-first">
        <div className="recon-first-head">
          <div>
            <h3>Recon · {host}</h3>
            <span className={`recon-verdict ${recon.preflight.go ? 'go' : 'nogo'}`}>
              {recon.preflight.go ? '✓ preflight GO' : '⚠ preflight NO-GO'}
            </span>
          </div>
          <div className="recon-first-head-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setShowIntel(true)}
            >
              full intel →
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setPhase('target')}>
              ← Change target
            </button>
          </div>
        </div>

        {showIntel && <ReconDetailModal recon={recon} onClose={() => setShowIntel(false)} />}

        <div className="recon-first-grid">
          {p?.server && <span className="recon-chip srv">{p.server}</span>}
          {recon.profile?.protocols?.http2 && <span className="recon-chip srv">HTTP/2</span>}
          {edge.map(([k, on]) => (
            <span key={k} className={`recon-chip ${on ? 'on' : 'off'}`}>
              {on ? '✓' : '✗'} {k}
            </span>
          ))}
          {(recon.dynamicPaths?.length ?? 0) > 0 && (
            <span className="recon-chip paths">{recon.dynamicPaths!.length} dynamic ⚡</span>
          )}
          {recon.loginPath && <span className="recon-chip login">login {recon.loginPath}</span>}
        </div>

        {discoveredPaths(recon).length > 0 && (
          <div className="recon-paths">
            <div className="recon-paths-head">
              <span className="rk">
                Discovered surface — pick what to hit ({selectedPaths.size}/
                {discoveredPaths(recon).length})
              </span>
              <span className="recon-paths-tools">
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() =>
                    setSelectedPaths(new Set(discoveredPaths(recon).map((d) => d.path)))
                  }
                >
                  All
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() =>
                    setSelectedPaths(
                      new Set(
                        discoveredPaths(recon)
                          .filter((d) => d.dynamic)
                          .map((d) => d.path),
                      ),
                    )
                  }
                >
                  Dynamic only ⚡
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => setSelectedPaths(new Set())}
                >
                  None
                </button>
              </span>
            </div>
            <div className="recon-paths-list">
              {discoveredPaths(recon).map((d) => (
                <label
                  key={d.path}
                  className={`recon-path${selectedPaths.has(d.path) ? ' on' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(d.path)}
                    onChange={(e) => {
                      const next = new Set(selectedPaths);
                      if (e.target.checked) next.add(d.path);
                      else next.delete(d.path);
                      setSelectedPaths(next);
                    }}
                  />
                  <code title={d.path}>{d.path}</code>
                  {d.dynamic && (
                    <span
                      className="recon-path-dyn"
                      title="A dynamic ⚡ path — a stronger stress target"
                    >
                      ⚡ dyn
                    </span>
                  )}
                </label>
              ))}
            </div>
            <span className="hint">
              Only the selected paths become the endpoint mix — the flood hits exactly what you
              pick.
            </span>
          </div>
        )}

        <div className="recon-first-suggest">
          <div className="rk">Suggested campaign — from what recon found</div>
          <ul>
            {suggestion.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>

        <div className="recon-levers">
          <div className="rk">
            Delivery levers — recommended from recon, adjust before you launch
          </div>
          {deriveLevers(recon).map((lv) => (
            <label key={lv.id} className={`lever${leverOn[lv.id] ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={!!leverOn[lv.id]}
                onChange={(e) => setLeverOn({ ...leverOn, [lv.id]: e.target.checked })}
              />
              <span className="lever-main">
                <span className="lever-label">
                  {lv.label}
                  {lv.signal ? (
                    <span className="lever-badge rec">recon: {lv.signal}</span>
                  ) : (
                    <span className="lever-badge opt">optional</span>
                  )}
                </span>
                <span className="lever-why">{lv.why}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setPhase('compose')}>
            Use these findings →
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setSuggestion({ initial: { target, probeUrl: target }, rationale: [] });
              setPhase('compose');
            }}
          >
            Start from scratch (keep the target)
          </button>
        </div>
      </div>
    );
  }

  // phase === 'target'
  return (
    <div className="recon-first">
      <h3>New campaign — recon first</h3>
      <p className="hint">
        Give a target and we profile it before you build: its edge posture, the paths worth hitting,
        and a suggested configuration. One flow, always recon-first.
      </p>
      <div className="field" style={{ maxWidth: '32rem' }}>
        <label>Target</label>
        {app.allowed.length > 0 && (
          <select
            aria-label="Choose an allowed target"
            className="target-select"
            value={host && app.allowed.includes(host) ? host : ''}
            onChange={(e) => {
              if (e.target.value) setTarget(defaultTargetUrl(e.target.value));
            }}
            style={{ marginBottom: '.4rem' }}
          >
            <option value="">Choose an allowed target…</option>
            {app.allowed.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        )}
        <input
          value={target}
          placeholder="https://bank.cz/"
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && allowed && !busy) runRecon();
          }}
        />
        <span className="hint">
          Pick a target above, or type a full URL (protocol / port / path).{' '}
          {app.allowed.length > 0 && <>Allowed hosts: {app.allowed.join(', ')}.</>}
          {target && !allowed && <b style={{ color: 'var(--danger)' }}> · not on the allowlist</b>}
        </span>
      </div>
      {error && (
        <p className="hint" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="page-actions">
        <button className="btn btn-primary" disabled={!allowed || busy} onClick={runRecon}>
          {busy ? 'Profiling…' : '🔎 Profile target'}
        </button>
        {onDone && (
          <button className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
