import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from './context.js';
import { api } from './api.js';
import type { Campaign, CampaignStatus, ReconReport, SuiteSequenceState } from './api.js';
import { RunTheater, RunVerdictLine, AbsorptionWidget, WrsPill, wrsClass, hostOf } from './ui.js';
import { ReplayFromRun } from './replay-from-run.js';
import { ReconDetailModal } from './recon-detail.js';
import { PageHead, GrafanaLink, useSuiteSequences, shortStepName } from './pages.js';

const SUITE_TERMINAL: CampaignStatus[] = [
  'COMPLETED',
  'KILLED_AUTO',
  'KILLED_MANUAL',
  'CANCELLED',
  'REJECTED',
];

/** Live countdown for the recovery gate: how long it has waited for the target
 *  to come back, and how long until it gives up and skips the wave. Ticks once a
 *  second off a fixed start time so it stays smooth between sequence polls. */
function GateTimer({ startedAt, maxWaitMs }: { startedAt: number; maxWaitMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const maxS = Math.max(1, Math.round(maxWaitMs / 1000));
  const elapsed = Math.min(maxS, Math.max(0, Math.floor((now - startedAt) / 1000)));
  const remaining = Math.max(0, maxS - elapsed);
  const pct = Math.min(100, (elapsed / maxS) * 100);
  return (
    <div className="gate-timer">
      <div className="gate-timer-row">
        <span>
          ⏱ waited <b>{elapsed}s</b> <span className="hint">/ {maxS}s</span>
        </span>
        <span className="hint">
          {remaining > 0
            ? `re-checking every 2s · skips this wave in ${remaining}s`
            : 'timed out — skipping this wave'}
        </span>
      </div>
      <div className="gate-timer-bar">
        <div className="gate-timer-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Recon posture of the suite's target — what the assessment is up against.
 *  Foregrounds the reconnaissance the tool already performed (seeded paths,
 *  edge posture, preflight verdict). */
function ReconStrip({
  recon,
  loading,
  onOpen,
}: {
  recon: ReconReport | null;
  loading: boolean;
  onOpen?: () => void;
}) {
  if (!recon) {
    return (
      <div className="recon-strip">
        <span className="recon-label">🔎 Recon</span>
        <span className="hint">
          {loading ? (
            <>
              <span className="spin" /> profiling target…
            </>
          ) : (
            'unavailable'
          )}
        </span>
      </div>
    );
  }
  const p = recon.profile.posture;
  const edge: { k: string; on: boolean }[] = [
    { k: 'WAF', on: p.waf },
    { k: 'CDN', on: p.cdn },
    { k: 'Rate-limit', on: p.rateLimiting },
    { k: 'Load-balancer', on: p.loadBalancer },
  ];
  const seeded = recon.suggestedPaths?.length ?? 0;
  const dynamic = recon.dynamicPaths?.length ?? 0;
  return (
    <button
      type="button"
      className="recon-strip clickable"
      onClick={onOpen}
      title="Open the full target intelligence"
    >
      <span className="recon-label">🔎 Recon</span>
      {p.server && <span className="recon-chip srv">{p.server}</span>}
      {recon.profile.protocols?.http2 && <span className="recon-chip srv">HTTP/2</span>}
      {edge.map((c) => (
        <span key={c.k} className={`recon-chip ${c.on ? 'on' : 'off'}`}>
          {c.on ? '✓' : '✗'} {c.k}
        </span>
      ))}
      {seeded > 0 && <span className="recon-chip paths">{seeded} seeded path(s)</span>}
      {dynamic > 0 && (
        <span
          className="recon-chip paths"
          title="Dynamic/expensive paths that pressure the origin (not cached static assets) — targeted first"
        >
          {dynamic} dynamic ⚡
        </span>
      )}
      {recon.loginPath && <span className="recon-chip login">login {recon.loginPath}</span>}
      <span className={`recon-chip ${recon.preflight.go ? 'go' : 'nogo'}`}>
        {recon.preflight.go ? 'preflight GO' : '⚠ preflight NO-GO'}
      </span>
      <span className="recon-more">full intel →</span>
    </button>
  );
}

/** Humanised labels for the inferred defense controls (seededProfile). */
// Re-exported for existing consumers (imported at the top for internal use).

/** The multi-step assessment as one live surface: a recon strip, a stepper that
 *  animates the wave in flight (and the recovery gate between waves), and the
 *  live protection panel for whichever step is running. Stays present between
 *  steps instead of collapsing to an empty "no run in flight". */
function SuiteTheater({
  seq,
  members,
  onKill,
  killing,
}: {
  seq?: SuiteSequenceState;
  members: Campaign[];
  onKill: (c: Campaign) => void;
  /** Kill-specific in-flight flags — NOT `busy` (which the blocking run holds the
   *  whole time, which would keep the kill switch disabled throughout the run). */
  killing: Record<string, boolean>;
}) {
  const ordered = useMemo(
    () => [...members].sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0)),
    [members],
  );
  const target = ordered[0]?.target ?? '';
  const suiteName = ordered[0]?.suiteName ?? 'Assessment suite';
  const runningStep = ordered.find((c) => c.status === 'RUNNING');
  const doneCount = ordered.filter((c) => SUITE_TERMINAL.includes(c.status)).length;
  const total = seq?.total ?? ordered.length;
  const seqActive = !!seq;
  // Between waves: the sequence is live but nothing is RUNNING yet — the
  // recovery gate is holding for the target to come back.
  const inGate = seqActive && !runningStep && doneCount < total && !seq?.paused;
  const nextStep = ordered.find(
    (c) => !SUITE_TERMINAL.includes(c.status) && c.status !== 'RUNNING',
  );
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const [recon, setRecon] = useState<ReconReport | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconOpen, setReconOpen] = useState(false);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setReconLoading(true);
    api
      .recon(target)
      .then((r) => alive && setRecon(r))
      .catch(() => undefined)
      .finally(() => alive && setReconLoading(false));
    return () => {
      alive = false;
    };
  }, [target]);

  const phase = seq?.autoPaused
    ? 'down'
    : seq?.paused
      ? 'paused'
      : runningStep
        ? 'running'
        : inGate
          ? 'gate'
          : 'settling';

  return (
    <div className="suite-theater">
      <div className="stheater-head">
        <div className="stheater-id">
          <div className="stheater-title">{suiteName}</div>
          <span className="hint">
            {hostOf(target) ?? target} · {total} steps
          </span>
        </div>
        <div className="stheater-progress-wrap">
          <div className="stheater-progress-label">
            <b>
              {doneCount}/{total}
            </b>{' '}
            steps
            <span className={`phase-tag phase-${phase}`}>{phase}</span>
          </div>
          <div className="stheater-progress">
            <div className="stheater-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <ReconStrip recon={recon} loading={reconLoading} onOpen={() => setReconOpen(true)} />
      {reconOpen && recon && <ReconDetailModal recon={recon} onClose={() => setReconOpen(false)} />}

      <div className="stepper" role="list">
        {ordered.map((c, i) => {
          const isDone = SUITE_TERMINAL.includes(c.status);
          const isRun = c.status === 'RUNNING';
          const isGateHere = inGate && nextStep?.id === c.id;
          const state = isRun ? 'run' : isGateHere ? 'gate' : isDone ? 'done' : 'queued';
          const killed = c.status === 'KILLED_AUTO' || c.status === 'KILLED_MANUAL';
          return (
            <div key={c.id} className={`step-node step-${state}`} role="listitem">
              <div className="step-connector" aria-hidden="true" />
              <div className="step-dot">
                {isDone
                  ? c.status === 'COMPLETED'
                    ? '✓'
                    : killed
                      ? '◼'
                      : '✕'
                  : isRun
                    ? ''
                    : i + 1}
              </div>
              <div className="step-meta">
                <div className="step-name" title={c.name}>
                  {shortStepName(c.name)}
                </div>
                {c.wrs ? (
                  <span className={`wrs-pill ${wrsClass(c.wrs.level)}`}>
                    {c.wrs.wrs} {c.wrs.level}
                  </span>
                ) : isRun ? (
                  <span className="step-tag live">● live</span>
                ) : isGateHere ? (
                  <span className="step-tag gate">recovering…</span>
                ) : (
                  <span className="step-tag">queued</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {runningStep ? (
        <RunTheater
          campaignId={runningStep.id}
          name={shortStepName(runningStep.name)}
          target={runningStep.target}
          engine={runningStep.agent}
          vector={runningStep.vector}
          onKill={() => onKill(runningStep)}
          killing={killing[runningStep.id]}
        />
      ) : inGate ? (
        <div className="gate-card">
          <div className="gate-scan" aria-hidden="true" />
          <div className="gate-text">
            <div className="gate-title">Recovery gate</div>
            <p className="hint">
              Waiting for <code>{hostOf(target) ?? target}</code> to become reachable again before
              the next wave — the origin may still be recovering from the previous step.
              {nextStep && (
                <>
                  {' '}
                  Next: <b>{shortStepName(nextStep.name)}</b>.
                </>
              )}
            </p>
            {seq?.gateStartedAt && (
              <GateTimer startedAt={seq.gateStartedAt} maxWaitMs={seq.gateMaxWaitMs ?? 90_000} />
            )}
          </div>
        </div>
      ) : seq?.autoPaused ? (
        <div className="gate-card down">
          <div className="gate-text">
            <div className="gate-title">Origin appears down</div>
            <p className="hint">
              <code>{hostOf(target) ?? target}</code> stayed unreachable across {seq.downSkips ?? 2}{' '}
              recovery checks, so the sequence <b>auto-paused</b> to protect the target — it will
              not relaunch load onto a downed origin. Bring the origin back, then <b>resume</b> to
              continue the remaining steps.
            </p>
          </div>
        </div>
      ) : seq?.paused ? (
        <div className="gate-card paused">
          <div className="gate-text">
            <div className="gate-title">Sequence paused</div>
            <p className="hint">Resume from the campaigns view to continue the remaining steps.</p>
          </div>
        </div>
      ) : (
        <p className="hint" style={{ padding: '1rem' }}>
          Suite settling — finalising the last step.
        </p>
      )}
    </div>
  );
}

/**
 * v2 Run Theater page — a focused live surface for whatever is running now. For
 * a multi-step suite it shows the whole sequence (recon, a live stepper, and the
 * recovery gate between waves) so it never collapses to "no run" mid-suite;
 * standalone campaigns still get the single live panel.
 */
/** Statuses a run can no longer be live in — used to decide whether the focused
 *  (just-launched) run should still be surfaced in the theater. */
const TERMINAL_STATUSES = new Set<CampaignStatus>(SUITE_TERMINAL);

export function RunTheaterPage() {
  const app = useApp();
  // Refresh campaigns on each sequence poll while a suite is in flight, so the
  // theater advances through the recovery gate without a manual navigation.
  const seqs = useSuiteSequences(app.refresh);
  const running = app.campaigns.filter((c) => c.status === 'RUNNING');
  // An active suite = one with a live sequence, or (fallback) the suite of a
  // running step even if the poll hasn't landed yet.
  const activeSuiteId = Object.keys(seqs)[0] ?? running.find((c) => c.suiteId)?.suiteId;
  const suiteMembers = activeSuiteId
    ? app.campaigns.filter((c) => c.suiteId === activeSuiteId)
    : [];
  const hasSuite = !!activeSuiteId && suiteMembers.length > 0;

  // Standalone runs (not part of the active suite) keep the single-run tabs.
  // When no suite is active, every running campaign is standalone.
  const runningStandalone = running.filter((c) => !(hasSuite && c.suiteId === activeSuiteId));
  // A `?run=<id>` param (set when launching or "Watch live →" from Campaigns)
  // focuses that run; otherwise the operator's manual pick wins, then the first.
  const [params] = useSearchParams();
  const focusRun = params.get('run');
  // Right after a launch the run spends a few seconds in baseline capture, still
  // APPROVED server-side, so it wouldn't appear in `running` yet. Surface the
  // focused run as long as it isn't terminal, so the launch→theater redirect
  // never lands on an empty stage (RunTheater streams live progress by id).
  const focusCampaign =
    focusRun && !runningStandalone.some((c) => c.id === focusRun)
      ? app.campaigns.find((c) => c.id === focusRun && !TERMINAL_STATUSES.has(c.status))
      : undefined;
  const standalone = focusCampaign ? [focusCampaign, ...runningStandalone] : runningStandalone;
  // When the focused run has just FINISHED, keep it on stage as a completion card
  // with its verdict and a "replay accounting for this run" follow-up — so the
  // theater doesn't just empty to "no run in flight" the moment a run settles.
  const finishedCampaign =
    focusRun && !standalone.some((c) => c.id === focusRun)
      ? app.campaigns.find((c) => c.id === focusRun && TERMINAL_STATUSES.has(c.status))
      : undefined;
  const finishedRun = finishedCampaign ? app.runs[finishedCampaign.id] : undefined;
  const [active, setActive] = useState<string | null>(null);
  const current =
    standalone.find((c) => c.id === active) ??
    standalone.find((c) => c.id === focusRun) ??
    standalone[0];

  // Keep the theater self-refreshing while there's a live/launching run to watch,
  // even if the global "any running" poll has paused (it stops the instant no
  // campaign reads RUNNING — which happens in the launch→baseline gap).
  const watching = standalone.length > 0 || hasSuite;
  const refresh = app.refresh;
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [watching, refresh]);

  // Pull the finished run's detail (verdict/absorption) if we don't already have
  // it — so the completion card can show the follow-up prompt after a navigate-back.
  const fetchRunFn = app.fetchRun;
  useEffect(() => {
    if (finishedCampaign && !finishedRun) void fetchRunFn(finishedCampaign);
  }, [finishedCampaign, finishedRun, fetchRunFn]);

  const grafanaTarget = suiteMembers[0]?.target ?? current?.target;

  return (
    <>
      <PageHead
        title="Run Theater"
        sub="Watch protection engage in real time — offered load vs what reaches origin, and the share the edge absorbs."
      />
      {grafanaTarget && (
        <GrafanaLink
          plane="run"
          label="Open this run in Grafana"
          target={hostOf(grafanaTarget) ?? grafanaTarget}
        />
      )}
      {!hasSuite && standalone.length === 0 && finishedCampaign ? (
        <div className="card run-complete-card">
          <div className="run-complete-head">
            <h3>Run complete — {finishedCampaign.name}</h3>
            {finishedCampaign.wrs && <WrsPill wrs={finishedCampaign.wrs} />}
          </div>
          {finishedRun ? (
            <>
              {finishedRun.assessment && <RunVerdictLine a={finishedRun.assessment} />}
              {finishedRun.edgeErrors && finishedRun.edgeErrors.length > 0 && (
                <p className="hint">
                  ⚑ The edge served its own error page under load — captured in the report.
                </p>
              )}
              <AbsorptionWidget run={finishedRun} />
              <p className="run-complete-cta-label">
                Push further — build the next campaign from what this run found:
              </p>
              <ReplayFromRun campaign={finishedCampaign} run={finishedRun} />
            </>
          ) : (
            <p className="muted">Loading the run’s conclusions…</p>
          )}
          <p className="hint">
            Full detail on <Link to="/campaigns">Campaigns</Link> · launch another from there.
          </p>
        </div>
      ) : !hasSuite && standalone.length === 0 ? (
        <div className="card">
          <p className="muted">
            No run in flight. Launch one from <Link to="/campaigns">Campaigns</Link> and it appears
            here live.
          </p>
        </div>
      ) : (
        <>
          {hasSuite && (
            <div className="card suite-theater-card">
              <SuiteTheater
                seq={activeSuiteId ? seqs[activeSuiteId] : undefined}
                members={suiteMembers}
                onKill={app.kill}
                killing={app.killing}
              />
            </div>
          )}
          {standalone.length > 1 && (
            <div style={{ display: 'flex', gap: '.4rem', margin: '.8rem 0', flexWrap: 'wrap' }}>
              {standalone.map((c) => (
                <button
                  key={c.id}
                  className={`btn btn-sm ${current?.id === c.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActive(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {standalone.length > 0 && current && (
            <div className="card">
              <RunTheater
                campaignId={current.id}
                name={current.name}
                target={current.target}
                vector={current.vector}
                onKill={() => app.kill(current)}
                // Gate on the kill-specific flag, never `busy`: the blocking
                // execute() holds `busy` for the whole run, which would keep the
                // kill switch disabled ("Killing…") throughout — the same bug the
                // card's kill button fixed.
                killing={app.killing[current.id]}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
