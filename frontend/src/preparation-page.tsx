import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import type { ReconReport } from './api.js';
import { useApp } from './context.js';
import { PageHead } from './pages.js';

/**
 * Preparation phase — target reconnaissance & readiness. Passive + published-
 * surface recon of an allowlisted, authorized target: a target profile, a real
 * path set, a pre-test baseline and a go/no-go preflight. Non-intrusive by
 * construction (the backend does no scan / fuzz / enumeration); this page only
 * renders what recon returns and lets the engineer copy the findings forward.
 */
export function PreparationPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [target, setTarget] = useState('https://bank.cz/');
  const [probeUrl, setProbeUrl] = useState('');
  const [report, setReport] = useState<ReconReport | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setReport(await api.recon(target.trim(), probeUrl.trim() || undefined));
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyPaths = () => {
    if (!report) return;
    if (!navigator.clipboard) {
      app.push('error', 'Clipboard unavailable in this browser.');
      return;
    }
    navigator.clipboard.writeText(report.suggestedPaths.join('\n')).then(
      () => app.push('success', 'Suggested paths copied to the clipboard.'),
      () => app.push('error', 'Clipboard unavailable.'),
    );
  };

  // Hand the observed profile off to the Plan phase (gap-planner).
  const sendToPlan = () => {
    if (!report) return;
    try {
      sessionStorage.setItem(
        'shieldtest.reconHandoff',
        JSON.stringify({ target: report.target, seededProfile: report.seededProfile }),
      );
    } catch {
      /* sessionStorage unavailable — navigate anyway */
    }
    navigate('/campaigns?tab=plan');
  };

  return (
    <>
      <PageHead
        title="Prepare"
        sub="Passive, published-surface reconnaissance of an authorized target — profile, real paths, baseline and a go/no-go before you run. No scan, no fuzzing, no enumeration."
      />

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="row" style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 16rem' }}>
            <span>Target</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://bank.cz/"
            />
          </label>
          <label className="field" style={{ flex: '1 1 16rem' }}>
            <span>Probe URL (optional)</span>
            <input
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
              placeholder="defaults to the target"
            />
          </label>
          <button className="btn btn-primary" onClick={run} disabled={busy || !target.trim()}>
            {busy ? 'Running recon…' : 'Run recon'}
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>
          The target must be in <code>ALLOWED_TARGETS</code> and authorized — recon refuses
          off-allowlist hosts.
        </p>
      </div>

      {report && (
        <>
          <div className={`card pf-banner ${report.preflight.go ? 'pf-go' : 'pf-nogo'}`}>
            <b>
              {report.preflight.go ? '✓ Go — ready to run' : '✗ No-go — resolve the blockers below'}
            </b>
          </div>

          <h2 className="section-title">Preflight readiness</h2>
          <div className="card" style={{ marginBottom: '1rem' }}>
            {report.preflight.items.map((it) => (
              <div key={it.key} className="pf-item">
                <span className={it.ok ? 'pf-ok' : it.required ? 'pf-bad' : 'pf-warn'}>
                  {it.ok ? '✓' : it.required ? '✗' : '!'}
                </span>
                <div>
                  <b>{it.label}</b>
                  {!it.required && <span className="gap-tag">optional</span>}
                  <div className="hint">{it.detail}</div>
                </div>
              </div>
            ))}
          </div>

          <h2 className="section-title">Target profile</h2>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="pf-grid">
              <span>Protection vendor</span>
              <b>{report.profile.vendor ?? '—'}</b>
              <span>WAF / CDN</span>
              <b>
                {report.profile.posture.waf ? 'WAF' : 'no WAF'} ·{' '}
                {report.profile.posture.cdn ? 'CDN' : 'no CDN'}
              </b>
              <span>Rate limiting observed</span>
              <b>{report.profile.posture.rateLimiting ? 'yes' : 'not observed'}</b>
              <span>Protocols</span>
              <b>
                {report.profile.protocols.http2 ? 'HTTP/2 ' : ''}
                {report.profile.protocols.http3 ? 'HTTP/3' : ''}
                {!report.profile.protocols.http2 && !report.profile.protocols.http3
                  ? 'HTTP/1.1'
                  : ''}
              </b>
              <span>Edge cache</span>
              <b>{report.profile.cache}</b>
              <span>Server</span>
              <b>{report.profile.server ?? '—'}</b>
            </div>
            <p className="hint">
              Seeds the gap-planner: {Object.keys(report.seededProfile).length} control(s) observed
              present.{' '}
              <button className="btn btn-sm btn-primary" onClick={sendToPlan}>
                Send to Plan →
              </button>
            </p>
          </div>

          <h2 className="section-title">Published surface</h2>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <p className="hint" style={{ marginTop: 0 }}>
              {report.suggestedPaths.length} real path(s) found
              {report.loginPath ? ` · login: ${report.loginPath}` : ''}.{' '}
              <button className="btn btn-sm btn-ghost" onClick={copyPaths}>
                Copy paths
              </button>
            </p>
            <div className="suite-steps">
              {report.suggestedPaths.map((p) => (
                <span key={p} className="chip-xs" title={p}>
                  {p}
                </span>
              ))}
            </div>
            {report.surface.disallow.length > 0 && (
              <p className="hint">
                Respected robots Disallow: {report.surface.disallow.join(', ')}
              </p>
            )}
          </div>

          <h2 className="section-title">Pre-test baseline</h2>
          <div className="card">
            <div className="pf-grid">
              <span>Samples</span>
              <b>{report.baseline.samples}</b>
              <span>Availability</span>
              <b>{report.baseline.availabilityPct}%</b>
              <span>Latency p50 / p95</span>
              <b>
                {report.baseline.latencyP50} / {report.baseline.latencyP95} ms
              </b>
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              Normal-operation reference — the WRS measures collateral against this, not an
              assumption.
            </p>
          </div>
        </>
      )}
    </>
  );
}
