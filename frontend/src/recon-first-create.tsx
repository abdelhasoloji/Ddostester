import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp, canDo } from './context.js';
import { defaultTargetUrl } from './target-url.js';
import { api } from './api.js';
import type { ReconReport, SuggestedAction, ActionSeed, TargetRequirement } from './api.js';
import { hostOf, emptyForm } from './campaign-form.js';
import type { CampaignFormSeed } from './campaign-form.js';
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
  const [actions, setActions] = useState<SuggestedAction[]>([]);
  // Seed handed to the full editor (one tuned action, or a bare "from scratch").
  const [editorSeed, setEditorSeed] = useState<Partial<CampaignFormSeed> | null>(null);
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
      const r = await api.reconActions(target);
      setRecon(r);
      setActions(r.actions ?? []);
      setPhase('recon');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'compose' && editorSeed) {
    return (
      <div>
        <div className="recon-first-back">
          <button className="btn btn-sm btn-ghost" onClick={() => setPhase('recon')}>
            ← Back to recon
          </button>
          <span className="hint">
            Editing an action against <code>{host}</code> — fields pre-filled; adjust anything.
          </span>
        </div>
        <NewCampaignForm initial={editorSeed} onDone={onDone} />
      </div>
    );
  }

  if (phase === 'recon' && recon) {
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

        <ReconActionsSurface
          recon={recon}
          actions={actions}
          onOpenEditor={(seed) => {
            setEditorSeed(seed);
            setPhase('compose');
          }}
          onScratch={() => {
            setEditorSeed({ target, probeUrl: target });
            setPhase('compose');
          }}
          onDone={onDone}
        />
      </div>
    );
  }

  // phase === 'target'
  return (
    <div className="recon-first recon-hero">
      <span className="recon-eyebrow">◎ Recon-first</span>
      <h3>Profile a target to begin</h3>
      <p className="hint recon-hero-sub">
        Give a target and we profile it before you build — its edge posture, the paths worth
        hitting, and a suggested configuration. One flow, always recon-first.
      </p>
      <div className="field recon-target-field">
        <label>Target</label>
        <div className={`recon-target-bar${target && !allowed ? ' invalid' : ''}`}>
          <span className="recon-target-icon" aria-hidden="true">
            🎯
          </span>
          <input
            className="recon-target-url"
            value={target}
            placeholder="https://bank.cz/"
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowed && !busy) runRecon();
            }}
          />
          {allowed && (
            <span className="recon-target-ok" title="On the allowlist" aria-label="allowed">
              ✓
            </span>
          )}
        </div>
        {app.allowed.length > 0 && (
          <div className="recon-allowed">
            <span className="recon-allowed-label">Allowed</span>
            {app.allowed.map((h) => (
              <button
                key={h}
                type="button"
                className={`recon-host-chip${host === h ? ' on' : ''}`}
                onClick={() => setTarget(defaultTargetUrl(h))}
              >
                {h}
              </button>
            ))}
          </div>
        )}
        <span className="hint">
          Pick a host above, or type a full URL (protocol / port / path).
          {target && !allowed && <b style={{ color: 'var(--danger)' }}> · not on the allowlist</b>}
        </span>
      </div>
      {error && (
        <p className="hint recon-error" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="page-actions recon-cta">
        <button
          className={`btn btn-primary btn-scan${busy ? ' scanning' : ''}`}
          disabled={!allowed || busy}
          onClick={runRecon}
        >
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

const REQ_LABEL: Record<TargetRequirement, string> = {
  h2: 'HTTP/2',
  waf: 'WAF',
  cache: 'edge cache',
  dynamic: 'dynamic endpoint',
};

/** Map a recon action seed → the classic form's seed shape (for deep editing).
 *  Lossy on scenario (profile resets to constant); the compose path is lossless. */
function actionSeedToForm(seed: ActionSeed): Partial<CampaignFormSeed> {
  return {
    name: seed.name,
    target: seed.target,
    probeUrl: seed.probeUrl,
    vector: seed.vector === 'http-post' ? 'http-post' : 'http-get',
    maxRps: seed.maxRps,
    concurrency: seed.concurrency,
    maxDurationSec: seed.maxDurationSec,
    endpoints: (seed.endpoints ?? []).map((e) => e.url).join('\n'),
    userAgents: (seed.userAgents ?? []).join('\n'),
    cacheBust: !!seed.cacheBust,
    noKeepAlive: !!seed.noKeepAlive,
    parallelism: seed.parallelism ?? 1,
    calibrate: !!seed.calibrate,
    agent: seed.agent ?? '',
    body: typeof seed.body === 'string' ? seed.body : '',
  };
}

/**
 * P7 — the recon-suggested Actions surface. Recon ranks the catalogue for THIS
 * target's posture into unitary, tunable actions; the operator picks one or more
 * and composes them into a governed campaign (1) or suite (N), or opens one in
 * the full editor. N/A actions (a required feature the target lacks) are shown
 * for reference but can't be selected.
 */
function ReconActionsSurface({
  recon: _recon,
  actions,
  onOpenEditor,
  onScratch,
  onDone,
}: {
  recon: ReconReport;
  actions: SuggestedAction[];
  onOpenEditor: (seed: Partial<CampaignFormSeed>) => void;
  onScratch: () => void;
  onDone?: () => void;
}) {
  const app = useApp();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const canCreate = canDo(app.role, 'create', app.authRequired);

  const applicable = actions.filter((a) => a.applicable);
  const na = actions.filter((a) => !a.applicable);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectedActions = actions.filter((a) => selected.has(a.id));

  const compose = async () => {
    if (selectedActions.length === 0) return;
    setBusy(true);
    try {
      const r = await api.composeActions({
        name: name.trim() || undefined,
        campaigns: selectedActions.map((a) => a.seed),
      });
      app.push(
        'success',
        r.suiteId
          ? `Assessment created — ${r.campaigns.length} steps (pending approval).`
          : `Campaign created — pending approval.`,
      );
      await app.refresh();
      onDone?.();
      navigate('/campaigns');
    } catch (e) {
      app.push('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const card = (a: SuggestedAction) => (
    <div
      key={a.id}
      className={`action-card${a.applicable ? '' : ' na'}${selected.has(a.id) ? ' on' : ''}`}
    >
      <label className="action-pick">
        <input
          type="checkbox"
          aria-label={`Select ${a.title}`}
          disabled={!a.applicable || !canCreate}
          checked={selected.has(a.id)}
          onChange={() => toggle(a.id)}
        />
      </label>
      <div className="action-body">
        <div className="action-head">
          <span className="action-title">{a.title}</span>
          {a.drs != null && <span className="engine-badge">DRS {a.drs}</span>}
          {(a.requires ?? []).map((r) => (
            <span key={r} className="engine-badge req">
              needs {REQ_LABEL[r] ?? r}
            </span>
          ))}
          {!a.applicable && <span className="engine-badge na">N/A here</span>}
        </div>
        <div className="action-params">
          {a.seed.vector.replace('http-', '').toUpperCase()} · {a.seed.maxRps} rps ·{' '}
          {a.seed.concurrency} conc · {a.seed.maxDurationSec}s
          {(a.seed.endpoints?.length ?? 0) > 0 ? ` · ${a.seed.endpoints!.length} endpoint(s)` : ''}
          {a.seed.cacheBust ? ' · cache-bust' : ''}
          {a.seed.noKeepAlive ? ' · no-keep-alive' : ''}
        </div>
        <ul className="action-why">
          {a.rationale.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <div className="action-foot">
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => onOpenEditor(actionSeedToForm(a.seed))}
          >
            Open in editor →
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="recon-actions">
      <div className="rk">
        Recommended actions — ranked for this target’s posture. Pick one or more, then create a
        governed campaign (or a suite). Each is fully editable.
      </div>
      <div className="action-list">{applicable.map(card)}</div>
      {na.length > 0 && (
        <details className="action-na">
          <summary>{na.length} not applicable to this target (kept for reference)</summary>
          <div className="action-list">{na.map(card)}</div>
        </details>
      )}
      {canCreate && (
        <div className="action-compose">
          <input
            className="tcb-name"
            placeholder="Assessment name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={selectedActions.length === 0 || busy}
            onClick={compose}
          >
            {busy ? <span className="spin" /> : null}
            {selectedActions.length <= 1
              ? 'Create campaign'
              : `Create assessment (${selectedActions.length})`}{' '}
            →
          </button>
          <button className="btn btn-ghost" onClick={onScratch}>
            Start from scratch
          </button>
        </div>
      )}
    </div>
  );
}
