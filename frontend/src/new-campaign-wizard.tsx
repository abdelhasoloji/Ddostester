import { useEffect, useMemo, useState } from 'react';
import { useApp } from './context.js';
import { api } from './api.js';
import type { Playbook } from './api.js';
import { formatCount } from './presets.js';
import { buildScenario, hostOf } from './campaign-form.js';
import { NewCampaignForm } from './new-campaign-form.js';
import {
  OBJECTIVES,
  getObjective,
  templatesForObjective,
  recommendTemplate,
  lastWrsFor,
  templateName,
  templateIcon,
  templateSummary,
  templateEngine,
  drsLevel,
  stepCount,
  peakRps,
  totalDurationSec,
  estRequests,
  withinCaps,
  capBreach,
  type Template,
} from './recommend.js';

const LAST_TARGET_KEY = 'shieldtest.lastTarget';
const STEPS = ['Objective', 'Target', 'Template', 'Review'];

/**
 * The guided, objective-first path to a new campaign. Four steps —
 * Objective → Target → Template → Review — that use the recommendation engine
 * (recommend.ts) to pre-pick the best-fit template from the preset + playbook
 * catalogue, ranked by installed engines, the effective operational caps and the
 * target's WRS history. "Advanced" hands off to the full classic form, seeded.
 */
export function NewCampaignWizard({ onDone }: { onDone?: () => void }) {
  const app = useApp();
  const caps = app.hardCaps;

  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  useEffect(() => {
    api
      .playbooks()
      .then(setPlaybooks)
      .catch(() => setPlaybooks([]));
  }, []);

  const [step, setStep] = useState(0);
  const [objectiveId, setObjectiveId] = useState<string | null>(null);
  const [target, setTarget] = useState(() => localStorage.getItem(LAST_TARGET_KEY) ?? '');
  const [probeUrl, setProbeUrl] = useState('');
  const [tpl, setTpl] = useState<Template | null>(null);
  const [name, setName] = useState('');
  const [attested, setAttested] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const objective = objectiveId ? getObjective(objectiveId) : undefined;
  const targetHost = hostOf(target);
  const targetAllowed = targetHost !== null && app.allowed.includes(targetHost);
  const probeHost = probeUrl.trim() ? hostOf(probeUrl) : targetHost;
  const probeAllowed = probeHost !== null && app.allowed.includes(probeHost);

  const engines = useMemo(
    () => app.agents.map((a) => ({ id: a.id, available: a.available })),
    [app.agents],
  );
  const lastWrs = useMemo(
    () => (target ? lastWrsFor(target, app.wrsSeries) : null),
    [target, app.wrsSeries],
  );

  const catalogue = useMemo(
    () => (objective ? templatesForObjective(objective, playbooks) : { single: [], suite: [] }),
    [objective, playbooks],
  );
  const reco = useMemo(
    () =>
      objective
        ? recommendTemplate(objective, catalogue, { engines, caps, lastWrs })
        : { pick: null, reason: '' },
    [objective, catalogue, caps, lastWrs, engines],
  );

  // When the objective (or its recommendation) changes, pre-select the pick.
  useEffect(() => {
    if (reco.pick) setTpl(reco.pick);
  }, [reco.pick]);

  const chooseObjective = (id: string) => {
    setObjectiveId(id);
    setTpl(null);
    setStep(1);
  };

  const pickHost = (h: string) => setTarget((t) => withHost(t, h));

  const suggestedName = () => {
    if (name.trim()) return name.trim();
    if (tpl && targetHost) return `${templateName(tpl)} — ${targetHost}`;
    return tpl ? templateName(tpl) : '';
  };

  const launch = async () => {
    if (!tpl || !targetAllowed || !attested) return;
    setBusy(true);
    try {
      localStorage.setItem(LAST_TARGET_KEY, target);
      const probe = probeUrl.trim() || target;
      if (tpl.kind === 'playbook') {
        const r = await api.instantiatePlaybook(tpl.id, { target, probeUrl: probe });
        app.push(
          'success',
          `Assessment created — ${r.campaigns.length} campaigns awaiting approval.`,
        );
        app.refresh();
      } else {
        const p = tpl.preset;
        await app.createCampaign({
          name: suggestedName(),
          target,
          probeUrl: probe,
          vector: 'http-get',
          maxRps: p.maxRps,
          concurrency: p.concurrency,
          maxDurationSec: p.maxDurationSec,
          scenario: buildScenario(p.profile, p.maxRps, p.maxDurationSec),
          agent: app.agents.some((a) => a.id === p.recommendedAgent && a.available)
            ? p.recommendedAgent
            : undefined,
          authorized: true,
        });
      }
      onDone?.();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Advanced escape hatch: the full classic form, seeded with the target and (for
  // a preset) its load shape. Playbooks have no single-form equivalent, so the
  // seed is the load shape of the playbook's heaviest step.
  if (advanced) {
    const seed =
      tpl?.kind === 'preset'
        ? {
            target,
            probeUrl: probeUrl.trim() || target,
            name: suggestedName(),
            maxRps: tpl.preset.maxRps,
            concurrency: tpl.preset.concurrency,
            maxDurationSec: tpl.preset.maxDurationSec,
            profile: tpl.preset.profile,
          }
        : { target, probeUrl: probeUrl.trim() || target, name: suggestedName() };
    return (
      <div>
        <div className="page-actions" style={{ marginBottom: '.5rem' }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setAdvanced(false)}>
            ← Back to guided setup
          </button>
        </div>
        <NewCampaignForm onDone={onDone} initial={seed} />
      </div>
    );
  }

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

      <Stepper step={step} />

      {step === 0 && (
        <div className="wizard-objectives">
          <p className="hint" style={{ marginBottom: '.75rem' }}>
            What do you want to find out? We&apos;ll recommend the best-fit template.
          </p>
          <div className="objective-grid">
            {OBJECTIVES.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`objective-card${objectiveId === o.id ? ' selected' : ''}`}
                onClick={() => chooseObjective(o.id)}
              >
                <span className="objective-icon" aria-hidden="true">
                  {o.icon}
                </span>
                <span className="objective-title">{o.title}</span>
                <span className="objective-q">{o.question}</span>
                <span className="objective-blurb">{o.blurb}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && objective && (
        <div>
          <p className="hint" style={{ marginBottom: '.75rem' }}>
            Objective:{' '}
            <b>
              {objective.icon} {objective.title}
            </b>
            . Pick the target (must be in the allowlist).
          </p>
          <div className="field">
            <label>Target (URL)</label>
            <input
              className={target && !targetAllowed ? 'invalid' : ''}
              placeholder="https://staging.example.com/"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            {app.allowed.length > 0 && (
              <div className="presets-row" style={{ marginTop: '.4rem' }}>
                <span className="presets-label">Allowed:</span>
                {app.allowed.map((h) => (
                  <button key={h} type="button" className="chip" onClick={() => pickHost(h)}>
                    {h}
                  </button>
                ))}
              </div>
            )}
            {target && !targetAllowed && (
              <span className="hint" style={{ color: 'var(--danger, #c0392b)' }}>
                Host not in the allowlist — only pre-approved targets are accepted.
              </span>
            )}
          </div>
          <div className="field">
            <label>
              Probe URL <span className="hint">(health check — defaults to the target)</span>
            </label>
            <input
              className={probeUrl && !probeAllowed ? 'invalid' : ''}
              placeholder={target || 'https://staging.example.com/health'}
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
            />
          </div>
          {targetAllowed && (
            <div className="wizard-history">
              {lastWrs ? (
                <span className={`engine-badge ${lastWrs.regression ? 'no' : 'ok'}`}>
                  Last WRS on {targetHost}: {lastWrs.wrs} ({lastWrs.level})
                  {lastWrs.regression ? ' · regression' : ''}
                </span>
              ) : (
                <span className="hint">No prior runs on {targetHost} — first assessment.</span>
              )}
            </div>
          )}
          <NavRow
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={!targetAllowed || (probeUrl.trim() !== '' && !probeAllowed)}
          />
        </div>
      )}

      {step === 2 && objective && (
        <div>
          {reco.pick && (
            <div className="reco-banner">
              <span className="reco-badge">★ Recommended</span>
              <b>
                {templateIcon(reco.pick)} {templateName(reco.pick)}
              </b>
              <span className="hint"> — {reco.reason}</span>
            </div>
          )}
          <TemplateGroup
            title="Single test"
            items={catalogue.single}
            selected={tpl}
            recommended={reco.pick}
            caps={caps}
            onPick={setTpl}
          />
          <TemplateGroup
            title="Full assessment (multi-step suite)"
            items={catalogue.suite}
            selected={tpl}
            recommended={reco.pick}
            caps={caps}
            onPick={setTpl}
          />
          <NavRow onBack={() => setStep(1)} onNext={() => setStep(3)} nextDisabled={!tpl} />
        </div>
      )}

      {step === 3 && objective && tpl && (
        <div>
          <div className="field">
            <label>Campaign name</label>
            <input
              placeholder={suggestedName()}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="review-summary kv">
            <div>
              <span className="k">Objective</span>
              <span className="v">
                {objective.icon} {objective.title}
              </span>
            </div>
            <div>
              <span className="k">Target</span>
              <span className="v">
                <code>{target}</code>
              </span>
            </div>
            <div>
              <span className="k">Template</span>
              <span className="v">
                {templateIcon(tpl)} {templateName(tpl)}
                {drsLevel(tpl) ? <span className="drs-badge"> DRS {drsLevel(tpl)}</span> : null}
              </span>
            </div>
            <div>
              <span className="k">What runs</span>
              <span className="v">
                {tpl.kind === 'playbook' ? `${stepCount(tpl)} campaigns (suite)` : '1 campaign'} ·
                peak {peakRps(tpl)} rps · {totalDurationSec(tpl)}s · ~
                {formatCount(estRequests(tpl))} requests
              </span>
            </div>
            <div>
              <span className="k">Engine</span>
              <span className="v">{templateEngine(tpl) ?? 'server default'}</span>
            </div>
            <div>
              <span className="k">Within limits</span>
              <span className="v">
                {withinCaps(tpl, caps) ? (
                  <span className="engine-badge ok">
                    ✓ within effective caps ({caps.maxRps}/{caps.maxConcurrency}/
                    {caps.maxDurationSec}s)
                  </span>
                ) : (
                  <span className="engine-badge no">✗ {capBreach(tpl, caps)}</span>
                )}
              </span>
            </div>
          </div>

          <label className="attest">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            I am authorized to test this target (attestation is recorded).
          </label>

          <NavRow
            onBack={() => setStep(2)}
            nextLabel={
              busy ? 'Creating…' : tpl.kind === 'playbook' ? 'Create assessment' : 'Create campaign'
            }
            onNext={launch}
            nextDisabled={busy || !attested || !targetAllowed || !withinCaps(tpl, caps)}
          />
          <div style={{ marginTop: '.5rem' }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setAdvanced(true)}
            >
              Advanced / fine-tune every field →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function withHost(current: string, host: string): string {
  try {
    const u = new URL(current);
    u.hostname = host;
    return u.toString();
  } catch {
    return `https://${host}/`;
  }
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="stepper">
      {STEPS.map((label, i) => (
        <div
          key={label}
          className={`stepper-item${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}
        >
          <span className="stepper-dot">{i < step ? '✓' : i + 1}</span>
          <span className="stepper-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function NavRow({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="wizard-nav">
      {onBack && (
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← Back
        </button>
      )}
      {onNext && (
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
        </button>
      )}
    </div>
  );
}

function TemplateGroup({
  title,
  items,
  selected,
  recommended,
  caps,
  onPick,
}: {
  title: string;
  items: Template[];
  selected: Template | null;
  recommended: Template | null;
  caps: { maxRps: number; maxConcurrency: number; maxDurationSec: number };
  onPick: (t: Template) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="template-group">
      <h3 className="template-group-title">{title}</h3>
      <div className="template-grid">
        {items.map((t) => {
          const ok = withinCaps(t, caps);
          const isSel = selected?.kind === t.kind && selected.id === t.id;
          const isReco = recommended?.kind === t.kind && recommended.id === t.id;
          return (
            <button
              key={`${t.kind}-${t.id}`}
              type="button"
              className={`template-card${isSel ? ' selected' : ''}${ok ? '' : ' disabled'}`}
              onClick={() => ok && onPick(t)}
              disabled={!ok}
              title={
                ok ? templateSummary(t) : `Exceeds the effective limits: ${capBreach(t, caps)}`
              }
            >
              <span className="template-head">
                <span className="template-name">
                  {templateIcon(t)} {templateName(t)}
                </span>
                {isReco && <span className="reco-badge sm">★</span>}
                {drsLevel(t) ? <span className="drs-badge">DRS {drsLevel(t)}</span> : null}
              </span>
              <span className="template-summary">{templateSummary(t)}</span>
              <span className="template-meta">
                {t.kind === 'playbook' ? `${stepCount(t)} steps · ` : ''}
                peak {peakRps(t)} rps · {totalDurationSec(t)}s · ~{formatCount(estRequests(t))} req
              </span>
              {!ok && (
                <span className="template-warn">Above current limit — {capBreach(t, caps)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
