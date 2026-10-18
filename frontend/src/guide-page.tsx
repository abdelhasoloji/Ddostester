import { useNavigate } from 'react-router-dom';
import { useApp } from './context.js';
import { PRESETS, PRESET_CATEGORIES, estimatedRequests, formatCount } from './presets.js';
import type { Preset } from './presets.js';
import { wrsClass } from './ui.js';
import { wrsRange } from './wrs.js';
import type { WrsBreakdown } from './api.js';
import { PageHead, EnginesList } from './pages.js';

const STEPS = [
  {
    n: 1,
    title: 'Create',
    icon: '✍️',
    body: 'In this workspace: the Launch wizard recommends a template for your objective, or browse Templates and compose lines, or build a Plan from recon. You attest you are authorized.',
  },
  {
    n: 2,
    title: 'Approve',
    icon: '✅',
    body: 'A Security Officer — not the author — signs off. Approval is valid for 24 hours.',
  },
  {
    n: 3,
    title: 'Execute',
    icon: '📡',
    body: 'Run now or on a schedule. The bounded HTTP generator and a legitimate probe run in parallel, under a 3-level kill switch.',
  },
  {
    n: 4,
    title: 'Score & report',
    icon: '🛡️',
    body: 'Get the WEDOS Resilience Score (WRS) and an HTML/PDF report; history and regressions tracked per target.',
  },
];

// How to read a WRS grade, and what to do about it. The numeric range for each
// band is derived from WRS_BANDS (wrs.ts) via wrsRange(), not repeated here.
const WRS_LEVELS: {
  level: WrsBreakdown['level'];
  meaning: string;
  action: string;
}[] = [
  {
    level: 'A+',
    meaning: 'Excellent — the service absorbed the load with negligible impact.',
    action: 'Keep a recurring baseline check to catch regressions early.',
  },
  {
    level: 'A',
    meaning: 'Strong resilience; minor degradation under load.',
    action: 'Good state. Re-test after significant infra or config changes.',
  },
  {
    level: 'B',
    meaning: 'Acceptable, but detection/mitigation or availability has room to improve.',
    action: 'Review the breakdown; tune autoscaling/caching, then re-test.',
  },
  {
    level: 'C',
    meaning: 'Noticeable impact on legitimate traffic during the run.',
    action: 'Investigate the weakest WRS component; plan a mitigation and re-test.',
  },
  {
    level: 'D',
    meaning: 'Poor — availability dropped materially under a bounded, lawful load.',
    action: 'Prioritise remediation; verify protection/kill-switch timings.',
  },
  {
    level: 'F',
    meaning: 'Failing — the service could not sustain the test.',
    action: 'Escalate; treat as a resilience defect before any production exposure.',
  },
];

export function GuidePage({ embedded = false }: { embedded?: boolean } = {}) {
  const app = useApp();
  const navigate = useNavigate();

  const use = (p: Preset) => {
    app.applyPreset(p);
    navigate('/campaigns?tab=launch');
  };

  return (
    <>
      {!embedded && (
        <PageHead
          title="How it works"
          sub="How a campaign works, from recon to report — plus ready-made configurations you can apply in one click."
        />
      )}

      <p className="guide-lead">
        A campaign is one bounded, governed test — from <b>recon</b> to <b>report</b>. Four steps,
        each safeguarded: an allowlist and hard caps up front, a second-person approval, a live kill
        switch, and a signed, tamper-evident record at the end.
      </p>

      <ol className="guide-flow">
        {STEPS.map((s) => (
          <li key={s.n} className="guide-step">
            <div className="guide-step-top">
              <span className="guide-step-n">{s.n}</span>
              <span className="guide-step-ico" aria-hidden="true">
                {s.icon}
              </span>
            </div>
            <div className="guide-step-title">{s.title}</div>
            <p className="guide-step-body">{s.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="section-title">Reading the score (WRS)</h2>
      <div className="card">
        <p className="subtitle" style={{ marginBottom: '.75rem' }}>
          The <b>WEDOS Resilience Score</b> (0–100) blends detection, mitigation, availability and
          collateral impact (<code>WRS = 0.20·D + 0.30·M + 0.30·A + 0.20·C</code>). Higher is
          better. A drop of more than 10 points versus the previous run on the same target is
          flagged as a <b>regression</b> (and can notify your team).
        </p>
        <div className="wrs-legend">
          {WRS_LEVELS.map((l) => (
            <div key={l.level} className="wrs-legend-row">
              <span className={`wrs ${wrsClass(l.level)}`}>
                <span className="wrs-score">{wrsRange(l.level)}</span> {l.level}
              </span>
              <div className="wrs-legend-text">
                <div>{l.meaning}</div>
                <div className="hint">{l.action}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: '.75rem' }}>
          When there is no protection integration, Detection and Mitigation are conservative
          estimates (the report marks the score as <i>estimated</i>). Focus on the lowest component
          in the breakdown to decide what to improve first.
        </p>
      </div>

      <h2 className="section-title">Recommended configurations</h2>
      <p className="subtitle" style={{ marginBottom: '.75rem' }}>
        Grouped by intent. Each preset sets the load shape and a recommended engine (used if
        installed, otherwise the server default) — never the target — and stays well within the
        safety caps. Start low, then increase gradually.
      </p>
      {PRESET_CATEGORIES.map((cat) => {
        const items = PRESETS.filter((p) => p.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="preset-group">
            <h3 className="preset-cat">{cat}</h3>
            <div className="preset-cards">
              {items.map((p) => {
                const eng = app.agents.find((a) => a.id === p.recommendedAgent);
                return (
                  <div key={p.id} className="preset-card">
                    <div className="preset-head">
                      <span className="preset-icon" aria-hidden="true">
                        {p.icon}
                      </span>
                      <span className="preset-name">{p.name}</span>
                    </div>
                    <p className="preset-summary">{p.summary}</p>
                    <p className="preset-when">{p.when}</p>
                    <div className="preset-specs">
                      <span>
                        <b>{p.maxRps}</b> rps
                      </span>
                      <span>
                        <b>{p.concurrency}</b> conc
                      </span>
                      <span>
                        <b>{p.maxDurationSec}</b>s
                      </span>
                      <span className="preset-profile">{p.profile}</span>
                    </div>
                    <div className="preset-est">
                      ≈ {formatCount(estimatedRequests(p.maxRps, p.maxDurationSec, p.profile))}{' '}
                      requests · engine <b>{p.recommendedAgent}</b>
                      {eng && !eng.available ? ' (unavailable — execution blocked)' : ''}
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => use(p)}>
                      Use this preset →
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <h2 className="section-title">Engines &amp; safety</h2>
      <div className="guide-two">
        <div className="card">
          <h3 className="guide-card-title">Load engines</h3>
          <p className="subtitle" style={{ marginBottom: '.75rem' }}>
            Every campaign runs on a <b>load engine</b>. The built-in one needs nothing installed;
            the others delegate to team-operated tools (k6, Vegeta, Locust, JMeter, Gatling). All
            produce <b>bounded HTTP</b> load only — no volumetric or exhaustion vector.
            Not-installed engines are greyed out, and constant-only engines can't run ramp/wave
            profiles.
          </p>
          <EnginesList />
          <p className="hint" style={{ marginTop: '.75rem' }}>
            Installed status is also in <b>Settings → Load engines</b>. Install an engine's binary
            on the server and it becomes selectable here.
          </p>
        </div>

        <div className="card">
          <h3 className="guide-card-title">Safety guardrails</h3>
          <ul className="guide-list">
            <li>
              Only allowlisted targets can be tested; everything else is rejected server-side.
            </li>
            <li>
              Hard caps on every run: ≤ {app.hardCapsCeiling.maxRps} rps, ≤{' '}
              {app.hardCapsCeiling.maxConcurrency} concurrent, ≤ {app.hardCapsCeiling.maxDurationSec}{' '}
              s (absolute per-run timeout) — reported by this server, not hardcoded here.
            </li>
            <li>
              The manual <b>kill switch</b> is always available during a run — use it if the target
              starts to struggle.
            </li>
            <li>Keep an eye on the probe (5xx rate, availability) while a campaign runs.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
