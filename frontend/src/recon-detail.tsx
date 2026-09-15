import { useEffect } from 'react';
import type { ReconReport } from './api.js';
import { hostOf } from './campaign-form.js';

/** Relative "3m ago" formatter — local copy so this module is self-contained. */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const CONTROL_LABELS: Record<string, string> = {
  synFloodProtection: 'SYN-flood protection',
  slowRequestTimeout: 'Slow-request timeout',
  rateLimiting: 'Rate limiting',
  originShielding: 'Origin shielding',
  cacheKeyPolicy: 'Cache-key policy',
  urlAllowlist: 'URL allowlist',
  methodPolicy: 'Method policy',
  http2Guard: 'HTTP/2 guard',
  challenge: 'Challenge / JS / CAPTCHA',
  wafSignatures: 'WAF signatures',
  bruteForceProtection: 'Brute-force protection',
};

/** One attack vector the recon findings make relevant, with the signal that opens it. */
export interface AttackVectorHint {
  vector: string;
  drs: string;
  signal: string;
  why: string;
}

/**
 * Derives the attack vectors this target's surface OPENS from the recon — the
 * "so what can I hit it with" that the raw posture implies. Pure, so it is
 * unit-tested. Each hint names the recon signal that enables it.
 */
export function attackVectorsFromRecon(recon: ReconReport): AttackVectorHint[] {
  const p = recon.profile?.posture ?? ({} as NonNullable<ReconReport['profile']>['posture']);
  const cache = recon.profile?.cache;
  const dyn = recon.dynamicPaths?.length ?? 0;
  const h2 = recon.profile?.protocols?.http2;
  const out: AttackVectorHint[] = [];
  if (cache === 'hit' || p.cdn)
    out.push({
      vector: 'Cache-busted GET flood',
      drs: '3–4',
      signal: cache === 'hit' ? 'cache HIT' : 'CDN',
      why: 'A unique query per request defeats the edge/CDN cache and forces every request to the origin — the vector that saturates an otherwise-cached GET target.',
    });
  if (dyn > 0)
    out.push({
      vector: 'Dynamic-path L7 multi-vector',
      drs: '5',
      signal: `${dyn} dynamic ⚡`,
      why: 'Spreading the load across the expensive dynamic paths pressures the origin backend (compute/DB), not cached static assets.',
    });
  if (recon.loginPath)
    out.push({
      vector: 'Auth POST flood',
      drs: '5',
      signal: `login ${recon.loginPath}`,
      why: 'The login/account path is uncacheable dynamic compute — a sustained POST flood stresses the auth backend a cache can’t absorb.',
    });
  if (h2)
    out.push({
      vector: 'HTTP/2 request-path stress',
      drs: '4–5',
      signal: 'HTTP/2',
      why: 'A bounded h2 GET flood, plus complete-request Rapid-Reset / Continuation shapes (no RST_STREAM abuse) against the multiplexed request path.',
    });
  if (p.rateLimiting)
    out.push({
      vector: 'Rate-limit breaking-point',
      drs: '4',
      signal: 'rate-limiter',
      why: 'Ramp the offered rate to find where the limiter engages and how much legitimate availability its response costs.',
    });
  if (p.waf)
    out.push({
      vector: 'UA-rotation / signature evasion',
      drs: '5',
      signal: 'WAF',
      why: 'Rotating client fingerprints across the flood tests whether signature-based filtering holds.',
    });
  if (!p.loadBalancer && !p.cdn)
    out.push({
      vector: 'Connection-concurrency (slow-hold)',
      drs: '3',
      signal: 'no load-balancer / CDN',
      why: 'Nothing (no load-balancer, no CDN edge) spreads or terminates connections in front of the origin — it is exposed to slow-header holds that occupy its connection pool.',
    });
  if (!p.waf && !p.cdn && !p.rateLimiting)
    out.push({
      vector: 'Direct volumetric (bare origin)',
      drs: '3–4',
      signal: 'no edge protection',
      why: 'Nothing fronts the origin — sustained POST / dynamic load reaches it directly.',
    });
  return out;
}

/** The full target-intelligence dossier — every field recon returns, laid out
 *  as a scannable dossier. Opened from the recon strip. */
export function ReconDetailModal({ recon, onClose }: { recon: ReconReport; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = recon.profile;
  const post = p.posture;
  const b = recon.baseline;
  const host = hostOf(recon.target) ?? recon.target;
  const yn = (v: boolean) => (v ? 'yes' : 'no');
  const fingerprint: { k: string; v: string; on?: boolean }[] = [
    { k: 'Server', v: post.server || p.server || '—' },
    { k: 'Vendor', v: p.vendor || '—' },
    { k: 'TLS', v: p.tls || '—' },
    { k: 'HTTP/2', v: yn(p.protocols?.http2), on: p.protocols?.http2 },
    { k: 'HTTP/3', v: yn(p.protocols?.http3), on: p.protocols?.http3 },
    { k: 'Cache', v: p.cache ?? 'unknown' },
  ];
  const edge: { k: string; on: boolean }[] = [
    { k: 'WAF', on: post.waf },
    { k: 'CDN', on: post.cdn },
    { k: 'Rate limiting', on: post.rateLimiting },
    { k: 'Load balancer', on: post.loadBalancer },
    { k: 'HSTS', on: post.hsts },
  ];
  const controls = Object.entries(recon.seededProfile ?? {});
  const paths = recon.suggestedPaths ?? recon.surface?.paths ?? [];

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal recon-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Target intelligence for ${host}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="recon-modal-head">
          <div>
            <h3>Target intelligence</h3>
            <span className="hint">
              <code>{host}</code>
              {recon.generatedAt ? ` · profiled ${relTime(recon.generatedAt)}` : ''}
            </span>
          </div>
          <span className={`recon-verdict ${recon.preflight.go ? 'go' : 'nogo'}`}>
            {recon.preflight.go ? '✓ preflight GO' : '⚠ preflight NO-GO'}
          </span>
          <button className="recon-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="recon-modal-body">
          <section className="recon-sec">
            <h4>Fingerprint</h4>
            <div className="recon-kv-grid">
              {fingerprint.map((f) => (
                <div key={f.k} className="recon-kv">
                  <span className="rk">{f.k}</span>
                  <span className={`rv ${f.on === true ? 'good' : ''}`}>{f.v}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="recon-sec">
            <h4>Edge posture</h4>
            <div className="recon-chip-row">
              {edge.map((c) => (
                <span key={c.k} className={`recon-chip lg ${c.on ? 'on' : 'off'}`}>
                  {c.on ? '✓' : '✗'} {c.k}
                </span>
              ))}
            </div>
            {post.signals?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Signals</span>
                <div className="recon-chip-row">
                  {post.signals.map((s, i) => (
                    <span key={i} className="recon-chip sig">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {post.securityHeaders?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Security headers</span>
                <div className="recon-chip-row">
                  {post.securityHeaders.map((h) => (
                    <span key={h} className="recon-chip on mono">
                      {h}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="recon-sec">
            <h4>Baseline (pre-load)</h4>
            <div className="recon-stat-row">
              <div className="recon-stat">
                <div className="rs-v good">{b?.availabilityPct ?? 100}%</div>
                <div className="rs-k">availability</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyP50 != null ? `${Math.round(b.latencyP50)}ms` : '—'}
                </div>
                <div className="rs-k">p50 latency</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyP95 != null ? `${Math.round(b.latencyP95)}ms` : '—'}
                </div>
                <div className="rs-k">p95 latency</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">
                  {b?.latencyMean != null ? `${Math.round(b.latencyMean)}ms` : '—'}
                </div>
                <div className="rs-k">mean</div>
              </div>
              <div className="recon-stat">
                <div className="rs-v">{b?.samples ?? 0}</div>
                <div className="rs-k">samples</div>
              </div>
            </div>
          </section>

          {controls.length > 0 && (
            <section className="recon-sec">
              <h4>Inferred defense controls</h4>
              <div className="recon-ctrl-grid">
                {controls.map(([key, status]) => (
                  <div key={key} className="recon-ctrl">
                    <span className="rc-name">{CONTROL_LABELS[key] ?? key}</span>
                    <span className={`rc-status rc-${status}`}>{status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="recon-sec">
            <h4>Attack surface</h4>
            {recon.loginPath && (
              <div className="recon-sub">
                <span className="rk">Login</span>
                <span className="recon-chip login mono">{recon.loginPath}</span>
              </div>
            )}
            {paths.length > 0 ? (
              <div className="recon-sub">
                <span className="rk">
                  Seeded paths ({paths.length}) — ranked by likely cost to the origin;{' '}
                  <b>⚡ dynamic</b> ones are targeted first
                </span>
                <div className="recon-chip-row wrap">
                  {paths.map((pt, i) => {
                    const isDyn = (recon.dynamicPaths ?? []).includes(pt);
                    return (
                      <span
                        key={i}
                        className={`recon-chip path mono${isDyn ? ' dynamic' : ''}`}
                        title={
                          isDyn
                            ? 'Dynamic/expensive — pressures the origin'
                            : 'Likely static/cached — light origin cost'
                        }
                      >
                        {isDyn ? '⚡ ' : ''}
                        {pt}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="hint">No real paths discovered — templates in use.</p>
            )}
            {recon.surface?.sitemaps?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">Sitemaps</span>
                <div className="recon-chip-row wrap">
                  {recon.surface.sitemaps.map((s, i) => (
                    <span key={i} className="recon-chip mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {recon.surface?.disallow?.length > 0 && (
              <div className="recon-sub">
                <span className="rk">robots.txt disallow</span>
                <div className="recon-chip-row wrap">
                  {recon.surface.disallow.map((s, i) => (
                    <span key={i} className="recon-chip off mono">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {(() => {
            const vectors = attackVectorsFromRecon(recon);
            return vectors.length > 0 ? (
              <section className="recon-sec">
                <h4>Attack vectors this surface opens</h4>
                <p className="hint">
                  What the posture above makes it worth hitting with — each vector names the recon
                  signal that enables it. All bounded, single-source, against the authorized target.
                </p>
                <div className="recon-vec-list">
                  {vectors.map((v) => (
                    <div key={v.vector} className="recon-vec">
                      <div className="rvec-head">
                        <span className="rvec-name">{v.vector}</span>
                        <span className="rvec-drs">DRS {v.drs}</span>
                      </div>
                      <span className="rvec-signal">
                        opened by <b>{v.signal}</b>
                      </span>
                      <p className="rvec-why">{v.why}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null;
          })()}

          {recon.preflight.items?.length > 0 && (
            <section className="recon-sec">
              <h4>Preflight checklist</h4>
              <ul className="recon-preflight">
                {recon.preflight.items.map((it) => (
                  <li key={it.key} className={it.ok ? 'ok' : it.required ? 'fail' : 'warn'}>
                    <span className="pf-icon">{it.ok ? '✓' : it.required ? '✕' : '▲'}</span>
                    <span className="pf-body">
                      <b>{it.label}</b>
                      {!it.required && !it.ok && <span className="pf-opt"> (optional)</span>}
                      {it.detail && <span className="pf-detail">{it.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
