import { useState } from 'react';
import { useApp } from './context.js';
import { api } from './api.js';
import type { ReconReport } from './api.js';
import { hostOf, emptyForm } from './campaign-form.js';
import { NewCampaignForm } from './new-campaign-form.js';

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

export function ReconFirstCreate({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const [target, setTarget] = useState('');
  const [phase, setPhase] = useState<'target' | 'recon' | 'compose'>('target');
  const [recon, setRecon] = useState<ReconReport | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
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
        <NewCampaignForm initial={suggestion.initial} onDone={onDone} />
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
          <button className="btn btn-sm btn-ghost" onClick={() => setPhase('target')}>
            ← Change target
          </button>
        </div>

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

        <div className="recon-first-suggest">
          <div className="rk">Suggested campaign — from what recon found</div>
          <ul>
            {suggestion.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>

        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setPhase('compose')}>
            Compose from these findings →
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
              if (e.target.value) setTarget(`https://${e.target.value}/`);
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
          {busy ? 'Profiling…' : '🔎 Run recon'}
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
