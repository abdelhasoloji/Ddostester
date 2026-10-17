import { DrsLaunchReview } from './drs-launch-review.js';
import { FleetCampaignLive } from './fleet-campaign-live.js';
import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { reportUrl, runTimelineCsvUrl, streamUrl } from './api.js';
import { UplotChart, type ChartSeries } from './PromChart.js';
import { LiveLineChart } from './live-chart.js';
import { ReplayFromRun } from './replay-from-run.js';
import { MitigationPanel } from './mitigation-panel.js';
import { FleetEvidencePanel } from './fleet-evidence.js';
import { ProbeQualityPanel } from './probe-quality.js';
import { DurableFleetEvidencePanel } from './durable-fleet-evidence.js';
import { APP_VERSION_LABEL, APP_BUILT } from './version.js';
import type {
  Campaign,
  CampaignRun,
  CampaignStatus,
  Role,
  RunAssessment,
  RunSample,
  WrsBreakdown,
  WrsPoint,
  LiveProgressData,
} from './api.js';
import { useApp, canDo } from './context.js';
import { requestAiSupport } from './assistant-bus.js';
import { Modal } from './modal.js';
import { wrsClass } from './wrs.js';
import { duplicateCampaignSeed, formatInterval, fmtDateTime } from './campaign-form.js';
// Re-exported so existing imports (pages.tsx, tests) keep resolving from './ui.js'.
export { NewCampaignForm } from './new-campaign-form.js';
export {
  buildAcceptance,
  buildAssertion,
  buildScenario,
  formatInterval,
  fmtDateTime,
  hostOf,
  parseDataset,
  parseEndpoints,
  parseFlow,
  parseFlowJson,
} from './campaign-form.js';

/**
 * Close a modal/overlay on the Escape key while it is open. Attaches the
 * listener only when `active`, so a closed modal costs nothing.
 */
const badgeLabel: Record<CampaignStatus, string> = {
  PENDING_APPROVAL: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  KILLED_AUTO: 'Auto-killed',
  KILLED_MANUAL: 'Manually killed',
  CANCELLED: 'Cancelled',
};

/** A small pill placed on a card that hands the block's live context to the
 *  assistant and opens it for an interactive exchange (see assistant-bus). */
export function AiSupportButton({
  title,
  context,
  className,
}: {
  title: string;
  context: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`ai-support-btn${className ? ' ' + className : ''}`}
      title="Ask the AI about this block — opens the assistant with its context"
      onClick={(e) => {
        e.stopPropagation();
        requestAiSupport({ title, context });
      }}
    >
      <span aria-hidden="true">🤖</span> AI support
    </button>
  );
}

export function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="dot" />
      {badgeLabel[status]}
    </span>
  );
}

// wrsClass now lives in wrs.ts (the single source of truth for WRS bands);
// re-exported here so existing `from './ui.js'` imports keep resolving.
export { wrsClass };

export function VerdictBadge({ verdict }: { verdict: 'PASS' | 'FAIL' }) {
  return (
    <span
      className={`badge ${verdict === 'PASS' ? 'badge-APPROVED' : 'badge-REJECTED'}`}
      title="SLO acceptance verdict"
    >
      SLO {verdict}
    </span>
  );
}

export function WrsPill({ wrs }: { wrs: WrsBreakdown }) {
  return (
    <span className={`wrs ${wrsClass(wrs.level)}`} title="WEDOS Resilience Score">
      <span className="wrs-score">{wrs.wrs}</span> {wrs.level}
    </span>
  );
}

/**
 * Flags a WRS whose measurement may be understated because OUR generator host was
 * the bottleneck (hard-stopped, or high event-loop lag during the run) — so a low
 * score isn't misread as the target failing.
 */
export function ConfidenceBadge({ run }: { run: CampaignRun }) {
  if (!run.confidence?.degraded) return null;
  return (
    <span className="badge warn" title={run.confidence.reasons.join(' ')}>
      ⚠ measurement degraded
    </span>
  );
}

/**
 * Protection absorption widget: how much of the offered load the target's edge
 * absorbed (rate-limited / tarpitted / 4xx) vs let through to origin — the
 * product-level "protection working" signal, shown next to the WRS.
 */
export function AbsorptionWidget({ run }: { run: CampaignRun }) {
  const g = run.generator;
  const a =
    run.absorption ??
    ({
      configuredRps: 0,
      achievedRps: g.actualRps,
      originRps: 0,
      absorbedRatio: g.totalRequests ? g.failed / g.totalRequests : 0,
      absorbedPct: g.totalRequests ? Math.round((g.failed / g.totalRequests) * 1000) / 10 : 0,
      totalRequests: g.totalRequests,
    } as NonNullable<CampaignRun['absorption']>);
  return (
    <div className="absorption">
      <div className="absorption-head">
        <span>Generator outcomes</span>
        {(g.unfinalizedRequests ?? 0) > 0 && (
          <span className="hint">
            {g.unfinalizedRequests} unfinalized HTTP outcomes; receipt and status unknown
          </span>
        )}
        {/* Neutral: a low absorbed% is not "bad" — the origin may simply have served
            the load. The run verdict above sets the interpretation. */}
        <span
          className="absorb-pct"
          title="Fraction of generator requests that failed; attribution requires corroboration"
        >
          {a.absorbedPct}% generator failures
        </span>
      </div>
      <div className="absorption-funnel">
        <div>
          <b>{a.configuredRps}</b>
          <span>configured</span>
        </div>
        <div className="arrow">→</div>
        <div>
          <b>{a.achievedRps.toFixed(1)}</b>
          <span>offered</span>
        </div>
        <div className="arrow">→</div>
        <div>
          <b>{a.originRps.toFixed(1)}</b>
          <span>successful responses</span>
        </div>
      </div>
      <div
        className="absorption-bar"
        title={`${a.absorbedPct}% generator failures (edge attribution requires corroboration)`}
      >
        <div className="absorb-fill" style={{ width: `${Math.min(100, a.absorbedPct)}%` }} />
      </div>
      {(a.rejectedRatio != null || a.tarpitRatio != null || a.offeredShortfall != null) && (
        <div
          className="absorb-mech"
          title="Observed HTTP failures, transport failures and offered-rate shortfall"
        >
          <span className="mech reject">
            HTTP failure {((a.rejectedRatio ?? 0) * 100).toFixed(0)}%
          </span>
          <span className="mech tarpit">
            transport failure {((a.tarpitRatio ?? 0) * 100).toFixed(0)}%
          </span>
          <span className="mech shortfall">
            shortfall {((a.offeredShortfall ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      )}
      {run.edgeCorroboration && (
        <div
          className={`absorb-corr ${run.edgeCorroboration.agrees ? 'agree' : 'disagree'}`}
          title="Bilateral: our inferred absorption vs the edge's own report"
        >
          {run.edgeCorroboration.agrees ? '✓ corroborated' : '⚠ disagrees'} — edge reports{' '}
          {Math.round(run.edgeCorroboration.edgeAbsorbedRatio * 100)}% (
          {run.edgeCorroboration.source})
        </div>
      )}
    </div>
  );
}

/**
 * Full-width WRS trend for one target, rendered with uPlot (homogeneous with the
 * app's other charts): a fixed 0–100 scale, a dashed threshold at 70, and a
 * click on the plot opens the nearest run's report. Hover shows the value in the
 * legend; the x-axis carries the time.
 */
export function WrsTrend({ points, regression }: { points: WrsPoint[]; regression: boolean }) {
  const sorted = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const series: ChartSeries[] = [
    {
      label: 'WRS',
      color: regression ? '#ef4444' : '#3b82f6',
      points: sorted.map((p) => [Date.parse(p.at) / 1000, p.wrs]),
    },
  ];
  return (
    <div className="wrs-trend">
      <UplotChart
        series={series}
        height={140}
        timeAxis
        yRange={[0, 100]}
        thresholds={[{ value: 70, label: 'target 70' }]}
        onPointClick={(i) => {
          const p = sorted[i];
          if (p) window.open(reportUrl(p.runId), '_blank', 'noopener');
        }}
      />
    </div>
  );
}

/**
 * The run's protection state, from the LIVE signals. The legitimate probe is the
 * truth-teller: if real users can't reach the target it is being taken DOWN
 * ('overwhelmed'), whatever share of the flood is failing. A high failed/sent
 * ratio ONLY means "protection engaging" when the probe stays up — an
 * unprotected origin that 5xx's every request also shows ~100% "absorbed", but
 * that is the origin collapsing, not an edge defending it. Pure, so it's tested.
 */
export function protectionBadgeState(
  waiting: boolean,
  absorbedPct: number,
  p: LiveProgressData | null,
): 'baseline' | 'overwhelmed' | 'protecting' | 'running' {
  if (waiting) return 'baseline';
  const samples = p?.probe?.samples ?? 0;
  const probeUp = samples ? (p!.probe!.available / samples) * 100 : 100;
  // Only trust the probe once it has taken at least one sample.
  if (samples > 0 && (p?.probe?.health === 'critical' || probeUp < 50)) return 'overwhelmed';
  // A protective EDGE absorbs by REJECTING (4xx / challenge) or DROPPING (no
  // response) — never by 5xx. So when the absorbed load is dominated by ORIGIN
  // 5xx, the target is FAILING at the origin, not an edge defending it — even if
  // a cheap/static probe path still answers (probeUp stays high while the dynamic
  // tier dies). That's "overwhelmed", never "protection engaging". Without this,
  // a bare origin 5xx-ing every request reads as an edge absorbing 100%.
  const cc = p?.statusCounts ?? {};
  if (absorbedPct >= 20 && (cc['5xx'] ?? 0) > (cc['4xx'] ?? 0)) return 'overwhelmed';
  if (absorbedPct >= 20) return 'protecting';
  return 'running';
}

/** Plain-language explanation of the run's protection state, shown on hover of
 *  the status badge so "protection engaging" isn't an unexplained label. */
export function protectionBadgeTitle(
  waiting: boolean,
  absorbedPct: number,
  p: LiveProgressData | null,
  vector?: string,
): string {
  if (waiting) return 'Capturing pre-load probe availability and latency.';
  const probeUp = p?.probe?.samples
    ? Math.round((p.probe.available / p.probe.samples) * 100)
    : null;
  if (vector === 'http-slowloris')
    return `Slow connections: ${p?.sent ?? 0} opened, ${p?.failed ?? 0} closed. Independent probe availability: ${probeUp ?? 'unknown'}%.`;
  return `Generator failures: ${absorbedPct}% (${p?.failed ?? 0}/${p?.sent ?? 0}). HTTP 4xx: ${p?.statusCounts?.['4xx'] ?? 0}; HTTP 5xx: ${p?.statusCounts?.['5xx'] ?? 0}. Independent probe availability: ${probeUp ?? 'unknown'}%. Edge absorption and origin impact require corroborating telemetry.`;
}

/**
 * v2 Run Theater — a focused, full-width live view of the running campaign. The
 * story is the two numbers pulling apart: offered load vs what reaches origin,
 * with the gap (what the edge absorbs) front and center, and the kill switch
 * always in reach. Subscribes to the same SSE stream as LiveProgress.
 */
export function RunTheater({
  fleet,
  fleetDeviceCount,
  campaignId,
  name,
  target,
  engine,
  vector,
  onKill,
  killing,
}: {
  fleet?: boolean;
  fleetDeviceCount?: number;
  campaignId: string;
  name: string;
  target: string;
  engine?: string;
  /** The load vector — drives which live cards make sense (a slowloris holds
   *  connections rather than streaming requests, so it shows a different set). */
  vector?: string;
  onKill?: () => void;
  killing?: boolean;
}) {
  const [p, setP] = useState<LiveProgressData | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [errored, setErrored] = useState(false);
  // Accumulate the chart series CLIENT-SIDE from the same live scalars the tiles
  // use — one point per elapsed second, `t` strictly monotonic. This is the
  // source of truth for the graphs: the server's `p.timeline` is unreliable for
  // external engines (sparse samples, an early availability default of 100 while
  // the probe has no data yet) which made the curves disagree with the tiles.
  const [series, setSeries] = useState<RunSample[]>([]);
  useEffect(() => {
    setErrored(false);
    setSeries([]); // a fresh run → fresh series
    const es = new EventSource(streamUrl(campaignId));
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'RUNNING') {
          setP(d);
          setWaiting(false);
          setErrored(false);
          const prb = d.probe;
          const sample: RunSample = {
            t: d.elapsedSec,
            rps: d.actualRps ?? 0,
            sent: d.sent ?? 0,
            failed: d.failed ?? 0,
            probe5xx: prb?.errorRate5xx ?? 0,
            availPct: prb?.samples ? Math.round((prb.available / prb.samples) * 1000) / 10 : 100,
            probeP95: prb?.latencyMs?.p95,
          };
          // Keep one point per elapsed second (SSE may push several per second):
          // replace the last when the second repeats, else append.
          setSeries((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.t === sample.t) return [...prev.slice(0, -1), sample];
            return [...prev, sample];
          });
        } else if (d.status === 'waiting') {
          setWaiting(true);
        } else if (d.status === 'done') {
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    // A dropped stream leaves the run going server-side; stop the spinner and
    // say so instead of pretending progress is still arriving.
    es.onerror = () => {
      setErrored(true);
    };
    return () => es.close();
  }, [campaignId]);

  const offered = p?.actualRps ?? 0;
  const originRps = p && p.elapsedSec > 0 ? p.successful / p.elapsedSec : 0;
  const absorbedPct = p && p.sent > 0 ? Math.round((p.failed / p.sent) * 100) : 0;
  const pct = p
    ? Math.min(100, Math.round((p.elapsedSec / Math.max(p.maxDurationSec, 1)) * 100))
    : 0;
  const eng = p?.engine ?? engine;
  // A slow-header (SlowLoris) run holds connections instead of streaming
  // requests — request/s cards read as all-zero and look "dead". Surface the
  // connection-hold story instead: opened / currently held / shed by the target.
  const isSlowloris = vector === 'http-slowloris';
  const shedPct = p && p.sent > 0 ? Math.round((p.failed / p.sent) * 100) : 0;
  // The generator only streams live counts on the built-in engine; external
  // engines (k6/vegeta/locust) run out-of-process and report nothing until they
  // settle. So offered/reached/absorbed would read a misleading 0 for the whole
  // run. Detect that (a few seconds in, still nothing sent) and show "—" plus a
  // note, rather than a fake zero — the live target health below is still real.
  const genLive = !!p && (p.sent > 0 || (p.actualRps ?? 0) > 0);
  const genPending = !!p && !isSlowloris && !genLive && p.elapsedSec >= 4;
  // Protection state from the live signals — the legit probe decides whether a
  // high absorbed% is "protection engaging" (probe up) or the target being taken
  // down (probe down). Keeps the headline badge honest on an unprotected origin.
  const badgeState = protectionBadgeState(waiting, absorbedPct, p);

  return (
    <div className="theater">
      <div className="theater-head">
        <div>
          <div className="theater-title">{name}</div>
          {fleet && <FleetCampaignLive campaignId={campaignId} expectedCount={fleetDeviceCount} />}
          <span className="hint">
            {target} · engine {eng ?? '—'}
            {p ? ` · ${p.elapsedSec}s / ${p.maxDurationSec}s` : ''}
          </span>
        </div>
        <span
          className={`badge ${badgeState === 'overwhelmed' ? 'crit' : badgeState === 'protecting' ? 'warn' : ''}`}
          style={{ cursor: 'help' }}
          title={protectionBadgeTitle(waiting, absorbedPct, p, vector)}
        >
          {badgeState === 'baseline'
            ? '● capturing baseline'
            : badgeState === 'overwhelmed'
              ? '● target overwhelmed'
              : badgeState === 'protecting'
                ? '● protection engaging'
                : '● running'}
        </span>
        {onKill && (
          <button className="btn btn-danger theater-kill" onClick={onKill} disabled={killing}>
            ◼ {killing ? 'Killing…' : 'Kill'}
          </button>
        )}
      </div>
      <div className="live-bar">
        <div className="live-fill" style={{ width: `${pct}%` }} />
      </div>

      {p && errored && (
        <p role="status" className="hint" style={{ color: 'var(--warning)' }}>
          ⚠ Live updates interrupted — last values may be stale. Reconnecting when available;
          refresh or sign in again if the session ended.
        </p>
      )}

      {!p ? (
        errored ? (
          <p className="hint" style={{ marginTop: '1rem', color: 'var(--warning)' }}>
            ⚠ Live updates interrupted — the run continues. Reconnecting when available; refresh or
            sign in again if the session ended.
          </p>
        ) : (
          <p className="hint" style={{ marginTop: '1rem' }}>
            <span className="spin" /> {waiting ? 'Capturing pre-load baseline…' : 'Starting run…'}
          </p>
        )
      ) : (
        <>
          {badgeState === 'overwhelmed' && !isSlowloris && (
            <div className="target-down" role="status" aria-live="polite">
              <div className="td-flash">⚠ TARGET DOWN</div>
              <div className="td-sub">
                origin failing under load — legitimate users can&rsquo;t get through
              </div>
              <div className="td-stats">
                <span>
                  <b>
                    {p.probe?.samples ? Math.round((p.probe.available / p.probe.samples) * 100) : 0}
                    %
                  </b>{' '}
                  legit availability
                </span>
                <span>
                  <b>{absorbedPct}%</b> failed / 5xx
                </span>
                <span>
                  successful responses <b>{Math.round(originRps)}</b> rps
                </span>
              </div>
            </div>
          )}
          <div className="theater-grid">
            {isSlowloris ? (
              <>
                <div className="theater-metric">
                  <div className="tm-k">Connections opened</div>
                  <div className="tm-v">{p.sent}</div>
                </div>
                <div className="theater-metric">
                  <div className="tm-k">Currently held</div>
                  <div className="tm-v good">{p.successful}</div>
                </div>
                <div className="theater-metric absorb">
                  <div className="tm-k">Shed by target</div>
                  <div className="tm-v warnv">
                    {p.failed} <small>· {shedPct}%</small>
                  </div>
                  <div className="absorption-bar" style={{ marginTop: '.4rem' }}>
                    <div className="absorb-fill" style={{ width: `${Math.min(100, shedPct)}%` }} />
                  </div>
                  <div className="hint" style={{ marginTop: '.35rem' }}>
                    high shed = good defense (target drops slow requests)
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="theater-metric">
                  <div className="tm-k">Offered</div>
                  <div className="tm-v">
                    {genPending ? (
                      <span className="tm-na" title="Computed when the engine settles">
                        —
                      </span>
                    ) : (
                      <>
                        {offered.toFixed(0)}
                        <small>req/s</small>
                      </>
                    )}
                  </div>
                </div>
                <div className="theater-metric">
                  <div className="tm-k">Successful responses</div>
                  <div className="tm-v good">
                    {genPending ? (
                      <span className="tm-na" title="Computed when the engine settles">
                        —
                      </span>
                    ) : (
                      <>
                        {originRps.toFixed(0)}
                        <small>req/s</small>
                      </>
                    )}
                  </div>
                </div>
                <div className="theater-metric absorb">
                  {/* When the target is overwhelmed the failures are the ORIGIN
                      erroring, not an edge absorbing the attack — label it
                      honestly so a bare-origin collapse can't read as protection. */}
                  <div className="tm-k">
                    {badgeState === 'overwhelmed'
                      ? 'HTTP / transport failures'
                      : 'Generator failures'}
                  </div>
                  {genPending ? (
                    <div className="tm-v">
                      <span className="tm-na" title="Computed when the engine settles">
                        —
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className={`tm-v ${badgeState === 'overwhelmed' ? 'bad' : 'warnv'}`}>
                        {absorbedPct}
                        <small>%</small>
                      </div>
                      <div className="absorption-bar" style={{ marginTop: '.4rem' }}>
                        <div
                          className={`absorb-fill${badgeState === 'overwhelmed' ? ' crit' : ''}`}
                          style={{ width: `${Math.min(100, absorbedPct)}%` }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
            <div className="theater-metric">
              <div className="tm-k">
                Legit probe
                {p.probe?.health && p.probe.health !== 'ok' && (
                  <span className={`health-badge health-${p.probe.health}`}>
                    {p.probe.health === 'critical' ? '● critical' : '▲ degraded'}
                  </span>
                )}
              </div>
              <div
                className={`tm-v ${p.probe?.health === 'critical' ? 'bad' : p.probe?.health === 'degraded' ? 'warnv' : 'good'}`}
              >
                {p.probe && p.probe.samples > 0
                  ? Math.round((p.probe.available / p.probe.samples) * 100)
                  : 100}
                <small>% up</small>
              </div>
            </div>
          </div>

          {genPending && (
            <p className="hint theater-gen-note" style={{ marginTop: '.6rem' }}>
              ⧗ {eng ? <b>{eng}</b> : 'This engine'} runs out-of-process — offered &amp; absorbed
              rates are computed when it settles. The live signals below (legitimate availability
              and latency) are measured throughout.
            </p>
          )}

          {p.statusCounts && Object.keys(p.statusCounts).length > 0 && (
            <div className="status-dist" style={{ marginTop: '.8rem' }}>
              {Object.entries(p.statusCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([bucket, n]) => (
                  <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                    {bucket} {n}
                  </span>
                ))}
            </div>
          )}

          <div style={{ marginTop: '.8rem' }}>
            <RunMetricsPanels timeline={series} />
          </div>
        </>
      )}
    </div>
  );
}

function LiveProgress({ campaignId, agent }: { campaignId: string; agent?: string }) {
  const [p, setP] = useState<LiveProgressData | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
    const es = new EventSource(streamUrl(campaignId));
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'RUNNING') {
          setP(d);
          setWaiting(false);
          setErrored(false);
        } else if (d.status === 'waiting') {
          // Run has started but is still capturing the pre-load baseline — keep
          // the stream open (don't close) and show a "capturing baseline" note.
          setWaiting(true);
        } else if (d.status === 'done') {
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    // Surface a dropped stream instead of spinning forever; the run itself
    // keeps going server-side and the card refreshes on the next poll.
    es.onerror = () => {
      setErrored(true);
    };
    return () => es.close();
  }, [campaignId]);
  if (!p)
    return (
      <div className="details">
        <span className="hint">
          {errored ? (
            <span style={{ color: 'var(--warning)' }}>
              ⚠ Live updates interrupted — reconnecting when available. Refresh or sign in again if
              the session ended.
            </span>
          ) : (
            <>
              <span className="spin" />
              {waiting ? 'Capturing pre-load baseline…' : 'Starting run…'}
            </>
          )}
        </span>
      </div>
    );
  const pct = Math.min(100, Math.round((p.elapsedSec / Math.max(p.maxDurationSec, 1)) * 100));
  const engine = p.engine ?? agent;
  // The built-in engine reports per-request counters; external engines don't,
  // so we always show elapsed time + the live probe health instead.
  const hasCounters = p.sent > 0;
  return (
    <div className="details">
      {errored && (
        <p role="status" className="hint" style={{ color: 'var(--warning)' }}>
          ⚠ Live updates interrupted — last values may be stale. Reconnecting when available;
          refresh or sign in again if the session ended.
        </p>
      )}
      <div className="live-bar">
        <div className="live-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="live-stats">
        <span>
          ⏱ {p.elapsedSec}s / {p.maxDurationSec}s
        </span>
        {hasCounters ? (
          <>
            <span>{p.sent} requests</span>
            <span>{p.actualRps} rps</span>
            <span>
              {p.successful} ok · {p.failed} failed
            </span>
            {p.elapsedSec > 0 && (
              <span
                className="live-absorb"
                title="Load reaching origin (2xx/3xx) vs the share the edge is absorbing right now"
              >
                → origin {(p.successful / p.elapsedSec).toFixed(1)}/s ·{' '}
                <b>{p.sent > 0 ? Math.round((p.failed / p.sent) * 100) : 0}% absorbed</b>
              </span>
            )}
          </>
        ) : (
          engine && <span>engine {engine} · running</span>
        )}
        {hasCounters && p.latencyMs && (
          <span title="Live latency percentiles over the run so far">
            ⚡ p50 {p.latencyMs.p50} · p95 {p.latencyMs.p95} · p99 {p.latencyMs.p99} ms
          </span>
        )}
        {p.probe && p.probe.samples > 0 && (
          <span title="Legitimate probe against the target">
            🩺 probe {p.probe.available}/{p.probe.samples} up · {p.probe.errorRate5xx}% 5xx
          </span>
        )}
        {p.probe?.health && p.probe.health !== 'ok' && (
          <span
            className={`health-badge health-${p.probe.health}`}
            title={
              p.probe.health === 'critical'
                ? 'Target availability at the auto-kill threshold — the run may be stopped to protect it'
                : 'Target degrading — availability or latency is off nominal (early warning before any auto-kill)'
            }
          >
            {p.probe.health === 'critical' ? '● critical' : '▲ degraded'}
          </span>
        )}
      </div>
      {p.statusCounts && Object.keys(p.statusCounts).length > 0 && (
        <div className="status-dist">
          {Object.entries(p.statusCounts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([bucket, n]) => (
              <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                {bucket} {n}
              </span>
            ))}
        </div>
      )}
      <RunTimeline samples={p.timeline ?? []} pending />
    </div>
  );
}

/**
 * Separation of duties (extended): the officer who approved a campaign may not
 * also execute it. Hide Run from the approver so no visible action leads to a
 * 403. Only meaningful when auth identifies the viewer.
 */
function canRunCampaign(
  c: Campaign,
  role: Role | null,
  ar: boolean,
  myEmail?: string,
  requireCiso = false,
  userMode: 'team' | 'single' = 'team',
  capabilities: readonly string[] = [],
  approvalPolicy: 'confirmation' | 'dual_control' = 'dual_control',
): boolean {
  if (c.drsMode === 'engine-validation' || c.drsMode === 'measured') return false;
  const drs = c.drsDocument?.revisions.find((r) => r.number === c.drsDocument?.currentRevision);
  if (drs && (drs.plan.mode !== 'synthetic-lab' || !drs.planHash || drs.finalizedAt)) return false;
  if (approvalPolicy === 'confirmation')
    return (
      (c.status === 'PENDING_APPROVAL' || c.status === 'APPROVED') &&
      canDo(role, 'execute', ar, userMode, capabilities)
    );
  if (c.status !== 'APPROVED' || !canDo(role, 'execute', ar, userMode, capabilities)) return false;
  if (ar && myEmail && c.approvedBy && myEmail.toLowerCase() === c.approvedBy.toLowerCase()) {
    return false;
  }
  // Dual control: no Run until the mandatory CISO sign-off is present.
  if (requireCiso && !c.cisoApprovedBy) return false;
  return true;
}

/** Whether to offer the CISO sign-off action on this campaign to this viewer. */
function canCisoApprove(
  c: Campaign,
  role: Role | null,
  ar: boolean,
  capabilities: readonly string[] = [],
): boolean {
  return (
    c.status === 'APPROVED' &&
    !c.cisoApprovedBy &&
    canDo(role, 'cisoApprove', ar, 'team', capabilities)
  );
}

/** A small badge showing the dual-control sign-off state. */
export function CisoBadge({ c }: { c: Campaign }) {
  if (c.cisoApprovedBy) {
    return (
      <span className="badge badge-APPROVED" title={`CISO sign-off by ${c.cisoApprovedBy}`}>
        CISO ✓
      </span>
    );
  }
  return (
    <span className="badge badge-PENDING_APPROVAL" title="Awaiting mandatory CISO sign-off">
      CISO pending
    </span>
  );
}

export function CampaignCard({ c }: { c: Campaign }) {
  const app = useApp();
  const navigate = useNavigate();
  const isBusy = app.busy[c.id];
  const role = app.role;
  const ar = app.authRequired;
  const canRun = canRunCampaign(
    c,
    role,
    ar,
    app.identity?.email,
    app.requireCisoApproval,
    app.userMode,
    app.capabilities,
    app.approvalPolicy,
  );
  const showCiso = app.requireCisoApproval && c.status !== 'PENDING_APPROVAL';
  return (
    <div className={`campaign${c.archived ? ' is-archived' : ''}`}>
      <div className="campaign-head">
        <span className="campaign-name">{c.name}</span>
        {(c.drsProfileId || c.drsMode) && (
          <span className="badge" title="Bounded functional measurement; not a DRS certification">
            {c.drsMode === 'engine-validation'
              ? 'DRS · Simulation'
              : c.drsMode === 'measured'
                ? 'DRS · Measured plan'
                : 'DRS · Laboratory'}
          </span>
        )}
        {c.archived && (
          <span className="badge badge-CANCELLED" title="Archived">
            Archived
          </span>
        )}
        <StatusBadge status={c.status} />
        {showCiso && <CisoBadge c={c} />}
        {c.wrs && <WrsPill wrs={c.wrs} />}
        {c.acceptanceResult && <VerdictBadge verdict={c.acceptanceResult.verdict} />}
        <div className="campaign-actions">
          {canDo(role, 'create', ar, app.userMode, app.capabilities) && (
            <button
              className="btn btn-sm"
              onClick={() => {
                app.queueReplay(duplicateCampaignSeed(c));
                navigate('/campaigns');
              }}
            >
              Duplicate / change generator
            </button>
          )}

          {app.approvalPolicy !== 'confirmation' &&
            c.status === 'PENDING_APPROVAL' &&
            canDo(role, 'approve', ar, app.userMode, app.capabilities) && (
              <button className="btn btn-sm" disabled={isBusy} onClick={() => app.setApproveFor(c)}>
                Approve / Reject
              </button>
            )}
          {app.approvalPolicy !== 'confirmation' &&
            canCisoApprove(c, role, ar, app.capabilities) && (
              <button
                className="btn btn-sm btn-primary"
                disabled={isBusy}
                onClick={() => app.cisoApprove(c)}
                title="Mandatory CISO sign-off (dual control)"
              >
                {isBusy ? <span className="spin" /> : null}CISO sign-off
              </button>
            )}
          {canRun && (
            <button
              className="btn btn-sm btn-primary"
              disabled={isBusy}
              onClick={() => app.setConfirmExec(c)}
            >
              {isBusy ? <span className="spin" /> : null}Run
            </button>
          )}
          {c.status === 'RUNNING' && canDo(role, 'kill', ar, app.userMode, app.capabilities) && (
            <button
              className="btn btn-sm btn-danger"
              disabled={app.killing[c.id]}
              onClick={() => app.kill(c)}
            >
              Kill
            </button>
          )}
          {(c.status === 'PENDING_APPROVAL' || c.status === 'APPROVED') &&
            canDo(role, 'approve', ar, app.userMode, app.capabilities) && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={isBusy}
                onClick={() => app.cancel(c)}
                title="Cancel this unrun campaign (terminal)"
              >
                Cancel campaign
              </button>
            )}
          {c.runId && (
            <a
              className="btn btn-sm btn-ghost"
              href={reportUrl(c.runId)}
              target="_blank"
              rel="noreferrer"
            >
              Report ↗
            </a>
          )}
          {canDo(role, 'create', ar, app.userMode, app.capabilities) && c.status !== 'RUNNING' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={isBusy}
              onClick={() => app.archive(c, !c.archived)}
              title={
                c.archived
                  ? 'Restore to the active list'
                  : 'Archive — hide from the default campaigns list'
              }
            >
              {c.archived ? 'Restore' : 'Archive'}
            </button>
          )}
          {c.status === 'RUNNING' ? (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => navigate(`/theater?run=${c.id}`)}
              title="Watch this run live in Run Theater"
            >
              Watch live →
            </button>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => app.openDetail(c)}>
              Details
            </button>
          )}
        </div>
      </div>
      <div className="campaign-meta">
        <span>
          Target: <code>{c.target}</code>
        </span>
        <span>{c.vector}</span>
        {c.agent && c.agent !== 'builtin' && (
          <span title="Load engine" className="engine-tag">
            ⚙ {c.agent}
          </span>
        )}
        <span>
          {c.maxRps} rps · {c.concurrency} conc · {c.maxDurationSec}s
          {c.scenario && c.scenario.length > 1 ? ` · scenario ${c.scenario.length} phases` : ''}
        </span>
        <span>
          by {c.createdBy}
          {c.approvedBy ? ` · appr. ${c.approvedBy}` : ''}
        </span>
        {c.createdAt && (
          <span title="When this campaign template was created (not its run)">
            📅 created {fmtDateTime(c.createdAt)}
          </span>
        )}
        {c.scheduledAt && (
          <span title="Scheduled run">🕒 {new Date(c.scheduledAt).toLocaleString()}</span>
        )}
        {c.recurrence && (
          <span title="Recurring campaign">
            🔁 every {formatInterval(c.recurrence.intervalMin)}
          </span>
        )}
        {c.flow && c.flow.length > 0 && (
          <span title="Multi-step L7 flow">🧭 {c.flow.length} steps</span>
        )}
        {c.suiteName && (
          <span title="Assessment playbook">
            📋 {c.suiteName}
            {typeof c.suiteOrder === 'number' ? ` #${c.suiteOrder + 1}` : ''}
          </span>
        )}
      </div>

      {c.status === 'APPROVED' && c.statusDetail?.startsWith('Last run failed') && (
        <p className="kill-note" role="alert">
          {c.statusDetail}
        </p>
      )}
      {c.statusDetail &&
        (c.status === 'KILLED_AUTO' ||
          c.status === 'KILLED_MANUAL' ||
          c.status === 'CANCELLED') && (
          <div className="kill-note" role="note">
            <span aria-hidden="true">🛑</span> {c.statusDetail}
          </div>
        )}

      {/* Read-only mitigation validation (TTD/TTM) for a completed run. */}
      {c.runId && <MitigationPanel runId={c.runId} />}

      {/* Only mount the inline live stream when the detail drawer is NOT open
          for this campaign — otherwise the drawer already shows it and both
          would open their own EventSource to the same /stream. */}
      {c.status === 'RUNNING' && app.expanded !== c.id && (
        <LiveProgress campaignId={c.id} agent={c.agent} />
      )}
    </div>
  );
}

/** Measured metrics + WRS breakdown for a finished run (used in the drawer). */
function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  );
}

/**
 * Run Theater graphs — offered vs reached-origin RPS, edge-absorbed % and
 * legitimate availability, plotted from the LIVE CLIENT TIMELINE (`p.timeline`),
 * the same per-tick source as the tiles above. Deliberately NOT fed from
 * Prometheus: the gauge scrape cadence + query window made those panels
 * mis-scale and lag the run (flat lines while the tiles read correctly). The
 * "Open in Grafana" deep-link still offers the full Prometheus dashboard.
 */
export interface TheaterPanel {
  label: string;
  series: ChartSeries[];
  yRange?: [number, number];
  yFromZero?: boolean;
}

/** Whether the generator streamed live counts in this run's samples. External
 *  engines (k6/vegeta/locust) run out-of-process and report nothing until settle,
 *  so `sent`/`rps` stay 0 for every tick — only the built-in engine streams them.
 *  Exported so the tiles and the panels agree on what is measurable live. */
export function hasLiveGenerator(samples: RunSample[]): boolean {
  return samples.some((s) => s.sent > 0 || s.rps > 0);
}

/**
 * Build the Run-Theater panels from the per-tick run samples. Pure, so it is
 * unit-tested. When the generator streams live counts (built-in engine) the
 * panels are offered-vs-origin RPS, edge-absorbed %, and availability — the
 * `sent`/`failed` cumulatives give the same ratios the tiles show. When it does
 * NOT (an external engine, out-of-process), those three would be flat-zero and
 * misleading, so the panels fall back to the two signals the probe measures live
 * for EVERY engine: legitimate availability and probe p95 latency. The offered/
 * absorbed figures are then computed at settle from the engine's own result.
 */
export function theaterPanels(samples: RunSample[]): TheaterPanel[] {
  const avail: [number, number][] = [];
  const p95: [number, number][] = [];
  for (const s of samples) {
    avail.push([s.t, s.availPct]);
    if (s.probeP95 != null) p95.push([s.t, s.probeP95]);
  }
  const availabilityPanel: TheaterPanel = {
    label: 'Legitimate availability (%)',
    yRange: [0, 100],
    series: [{ label: 'probe avail %', points: avail, color: '#10b981' }],
  };

  if (!hasLiveGenerator(samples)) {
    // External engine: no live generator stream. Show what IS measured live.
    return [
      availabilityPanel,
      {
        label: 'Legitimate latency p95 (ms)',
        yFromZero: true,
        series: [{ label: 'probe p95', points: p95, color: '#3b82f6' }],
      },
    ];
  }

  const offered: [number, number][] = [];
  const origin: [number, number][] = [];
  const absorbed: [number, number][] = [];
  for (const s of samples) {
    const success = s.sent > 0 ? Math.max(0, (s.sent - s.failed) / s.sent) : 1;
    offered.push([s.t, s.rps]);
    origin.push([s.t, s.rps * success]); // instantaneous rps reaching origin
    absorbed.push([s.t, s.sent > 0 ? (s.failed / s.sent) * 100 : 0]);
  }
  return [
    {
      label: 'Offered vs successful-response RPS',
      yFromZero: true,
      series: [
        { label: 'offered', points: offered, color: '#3b82f6' },
        { label: 'successful responses', points: origin, color: '#10b981' },
      ],
    },
    {
      label: 'Generator failures (%)',
      yRange: [0, 100],
      series: [{ label: 'generator failures %', points: absorbed, color: '#f59e0b' }],
    },
    availabilityPanel,
  ];
}

/** The shared x-domain max for the Run-Theater panels: the largest elapsed
 *  second across the samples (never below 1). Every panel is drawn on [0, this]
 *  so they stay aligned and no line is ever plotted past the frame. NOT rounded
 *  — a rounded-down max would clip the last point. Pure, so it is unit-tested. */
export function panelsXMax(samples: RunSample[]): number {
  return Math.max(1, ...samples.map((s) => s.t));
}

function RunMetricsPanels({ timeline }: { timeline: RunSample[] }) {
  const panels = theaterPanels(timeline);
  const enough = timeline.length >= 2;
  const xMax = panelsXMax(timeline);
  const tMax = enough ? Math.round(xMax) : 0;
  return (
    <div className="run-metrics">
      <div className="run-metrics-head">
        {/* The Grafana deep-link lives once at the top of the page ("Open this run
            in Grafana"); no second link here. */}
        <div className="posture-title">Run graphs · live{enough ? ` · over ${tMax}s` : ''}</div>
      </div>
      <div className="run-metrics-grid">
        {panels.map((p) => (
          <div key={p.label} className="run-metrics-panel">
            <div className="rmp-title">{p.label}</div>
            {enough ? (
              <LiveLineChart series={p.series} height={140} xDomain={[0, xMax]} yRange={p.yRange} />
            ) : (
              <div className="timeline-pending hint">Collecting samples…</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Per-run time-series (client-side, every engine): requests/s and probe 5xx
 *  over elapsed seconds, rendered with uPlot so it matches the other charts. */
function RunTimeline({
  samples,
  csvHref,
  pending,
}: {
  samples: RunSample[];
  csvHref?: string;
  /** Live run: show a "collecting" placeholder before the first points land,
      so an in-flight step never renders as a silent, empty chart. */
  pending?: boolean;
}) {
  if (samples.length < 2) {
    if (!pending) return null;
    return (
      <div className="posture">
        <div className="posture-title">Run timeline</div>
        <div className="timeline-pending hint">
          Collecting run samples… the chart appears once the engine reports its first seconds.
        </div>
      </div>
    );
  }
  const xMax = Math.max(...samples.map((s) => s.t), 1);
  const tMax = Math.round(xMax);
  const series: ChartSeries[] = [
    { label: 'requests/s', points: samples.map((s) => [s.t, s.rps]), color: '#3b82f6' },
    {
      label: 'probe 5xx %',
      points: samples.map((s) => [s.t, s.probe5xx]),
      color: '#ef4444',
      axis: 'right',
    },
  ];
  return (
    <div className="posture">
      <div className="posture-title">Run timeline</div>
      <LiveLineChart series={series} height={150} xDomain={[0, xMax]} />
      <div className="timeline-legend">
        <span className="hint">over {tMax}s</span>
        {csvHref && (
          <a href={csvHref} target="_blank" rel="noreferrer">
            CSV ↗
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * The faithful verdict for a run — the SAME assessment the report shows, so the
 * detail page and the report never tell different stories. Leads the detail view.
 */
export function RunVerdictLine({ a }: { a: RunAssessment }) {
  const color =
    a.verdict === 'held'
      ? 'var(--success)'
      : a.verdict === 'breached'
        ? 'var(--danger)'
        : 'var(--warning)';
  const rate = a.configuredRps
    ? ` · ${a.achievedRps}/${a.configuredRps} rps (${Math.round(a.deliveryRatio * 100)}%)`
    : '';
  return (
    <div className="run-verdict" style={{ marginBottom: '.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
        <span className="badge" style={{ color, borderColor: color }}>
          {a.verdict}
        </span>
        <span className="hint">
          mechanism: <b>{a.mechanism}</b>
          {rate}
        </span>
      </div>
      <p className="hint" style={{ margin: '.35rem 0 0' }}>
        {a.observation}
      </p>
      {a.verdict !== 'breached' && a.caveats.length > 0 && (
        <p className="hint warn-hint" style={{ margin: '.35rem 0 0' }}>
          ⚠ {a.caveats.join(' ')}
        </p>
      )}
    </div>
  );
}

/** Compact callout for edge-served error pages captured under load — the edge's
 *  own first-party evidence of the mechanism that engaged. */
function EdgeErrorNote({ errors }: { errors: NonNullable<CampaignRun['edgeErrors']> }) {
  return (
    <div className="edge-errors" role="note">
      <div className="edge-errors-head">⚑ Edge served its own error page under load</div>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>
            <b>HTTP {e.status}</b>
            {e.vendor ? ` · ${e.vendor}` : ''} ·{' '}
            {e.layer === 'origin'
              ? 'origin buckled behind a healthy edge'
              : e.layer === 'rate-limit'
                ? 'rate-limited'
                : e.layer === 'challenge'
                  ? 'challenge / block page'
                  : 'edge error'}
            {e.originIpLeaked && (
              <span className="edge-leak" title="Information disclosure — never targeted">
                {' '}
                · leaked origin IP {e.originIpLeaked}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RunDetails({ run }: { run: CampaignRun }) {
  const g = run.generator;
  const reportedAgents =
    g.fleet?.counterCoverage?.reportedAgents ??
    g.fleet?.shards.filter((shard) => shard.result?.generator).length;
  const partialCounters = !!g.fleet && (reportedAgents ?? 0) < g.fleet.shards.length;
  const counterValue = (value: number) => (partialCounters && !reportedAgents ? 'unknown' : value);
  return (
    <div className="details">
      {run.assessment && <RunVerdictLine a={run.assessment} />}
      {run.edgeErrors && run.edgeErrors.length > 0 && <EdgeErrorNote errors={run.edgeErrors} />}
      <div className="metrics">
        <Metric label={partialCounters ? 'Reported requests (partial)' : 'Requests'}>
          {counterValue(g.totalRequests)}
        </Metric>
        <Metric label={partialCounters ? 'Reported outcomes (partial)' : 'Success / failures'}>
          {counterValue(g.successful)} / {counterValue(g.failed)}
        </Metric>
        {g.assertionsChecked ? (
          <Metric label="Assertion failures">
            {g.assertionFailures ?? 0} / {g.assertionsChecked}
          </Metric>
        ) : null}
        <Metric label={partialCounters ? 'Reported RPS (partial)' : 'Actual RPS'}>
          {counterValue(g.actualRps)}
        </Metric>
        <Metric label={partialCounters ? 'Reported latency p95 (partial)' : 'Latency p95'}>
          {g.latencySampleCount === 0 ? 'unknown' : `${counterValue(g.latencyMs.p95)} ms`}
        </Metric>
        <Metric label="Probe 5xx">{run.probe.errorRate5xx}%</Metric>
        <Metric label="Probe availability">
          {run.probe.available}/{run.probe.samples}
        </Metric>
      </div>
      {Object.keys(g.statusCounts).length > 0 && (
        <div className="status-dist">
          {Object.entries(g.statusCounts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([bucket, n]) => (
              <span key={bucket} className={`chip-xs ${bucket === '2xx' ? 'on' : 'off'}`}>
                {bucket} {n}
              </span>
            ))}
          {Object.entries(g.errors).map(([name, n]) => (
            <span key={name} className="chip-xs off" title="transport/connection error">
              {name} {n}
            </span>
          ))}
        </div>
      )}
      {run.baseline && (
        <div className="metrics" style={{ marginTop: '.5rem' }}>
          <Metric label="Baseline availability">
            {run.baseline.observation?.complete === false
              ? 'unknown'
              : `${run.baseline.availabilityPct}%`}
          </Metric>
          <Metric label="Baseline latency p95">
            {run.baseline.observation?.complete === false
              ? 'unknown'
              : `${run.baseline.latencyMs.p95} ms`}
          </Metric>
          {run.baseline.observation && (
            <Metric label="Baseline observations">
              {run.baseline.observation.receivedSamples}/{run.baseline.observation.expectedSamples}{' '}
              received
            </Metric>
          )}
          {run.baselineDelta && run.baseline.observation?.complete !== false && (
            <>
              <Metric label="Δ latency p95 (load)">
                {run.baselineDelta.latencyP95DeltaMs >= 0 ? '+' : ''}
                {run.baselineDelta.latencyP95DeltaMs} ms
              </Metric>
              <Metric label="Δ availability (load)">
                {run.baselineDelta.availabilityDeltaPct >= 0 ? '+' : ''}
                {run.baselineDelta.availabilityDeltaPct} pts
              </Metric>
            </>
          )}
        </div>
      )}
      {run.reference && (
        <div className="metrics" style={{ marginTop: '.5rem' }}>
          <Metric label="Reference vantage">
            {run.reference.availPct}% up
            <span
              className={`health-badge ${run.reference.targetAttributed ? 'health-degraded' : 'health-critical'}`}
              style={{ marginLeft: 6 }}
              title={
                run.reference.targetAttributed
                  ? 'The independent reference stayed reachable while the target degraded — impact attributed to the target.'
                  : 'The reference was also unreachable — the outage may be network-side or our own egress, not the target (verdict inconclusive).'
              }
            >
              {run.reference.targetAttributed ? 'target-attributed' : 'inconclusive'}
            </span>
          </Metric>
        </div>
      )}
      {run.targetTelemetry && run.targetTelemetry.length > 0 && (
        <div className="metrics" style={{ marginTop: '.5rem' }}>
          {(() => {
            const peak = (
              pick: (s: NonNullable<CampaignRun['targetTelemetry']>[number]) => number | undefined,
            ) => {
              const vals = run.targetTelemetry!.map(pick).filter((v): v is number => v != null);
              return vals.length ? Math.max(...vals) : undefined;
            };
            const cpu = peak((s) => s.cpuPct);
            const ct = peak((s) => s.conntrack);
            return (
              <>
                {cpu != null && <Metric label="Target CPU peak">{cpu}%</Metric>}
                {ct != null && <Metric label="Target conntrack peak">{ct}</Metric>}
              </>
            );
          })()}
        </div>
      )}
      {run.timeline && (
        <RunTimeline samples={run.timeline} csvHref={runTimelineCsvUrl(run.runId)} />
      )}
      <AbsorptionWidget run={run} />
      <FleetEvidencePanel run={run} />
      <ProbeQualityPanel probe={run.probe} />
      {run.recoveryBeforeRun && (
        <p>
          Recovery before this suite step:{' '}
          {run.recoveryBeforeRun.available && run.recoveryBeforeRun.verified !== false
            ? 'available'
            : 'unverified or unavailable'}{' '}
          · {run.recoveryBeforeRun.checks} checks ·{' '}
          {(run.recoveryBeforeRun.waitedMs / 1000).toFixed(1)} s
        </p>
      )}
      {run.recoveryBeforeRun?.quality && (
        <ProbeQualityPanel probe={run.recoveryBeforeRun} title="Recovery before step diagnostics" />
      )}
      {run.baseline?.quality && (
        <ProbeQualityPanel probe={run.baseline} title="Remote baseline diagnostics" />
      )}
      {run.confidence?.degraded && (
        <p className="hint warn-hint" style={{ marginTop: '.5rem' }}>
          ⚠ <b>Measurement degraded — this WRS may be understated.</b>{' '}
          {run.confidence.reasons.join(' ')}
        </p>
      )}
      {run.probeContended && (
        <p className="hint" style={{ marginTop: '.5rem' }}>
          ℹ <b>Probe and generator disagree.</b> Raw probe measurements and safety thresholds were
          preserved. The cause needs independent telemetry; this result is uncertain.
        </p>
      )}
      {run.breakingPoint &&
        (run.breakingPoint.reached ? (
          <p className="hint warn-hint" style={{ marginTop: '.5rem' }}>
            💥 <b>Breaking point ≈ {run.breakingPoint.rps} rps.</b> The target started failing en
            masse ({Math.round((run.breakingPoint.failRate ?? 0) * 100)}% of requests) around{' '}
            {run.breakingPoint.atSec}s. Highest rate it held cleanly:{' '}
            <b>{run.breakingPoint.sustainedRps} rps</b>.
          </p>
        ) : (
          run.breakingPoint.sustainedRps > 0 && (
            <p className="hint" style={{ marginTop: '.5rem' }}>
              🛡 <b>No breaking point reached.</b> The target held across the whole offered load —
              sustained up to <b>{run.breakingPoint.sustainedRps} rps</b> without failing en masse.
            </p>
          )
        ))}
      <div className="wrs-breakdown">
        <span>
          Detection{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.detection}</b>
        </span>
        <span>
          Mitigation{run.wrs.estimated ? ' (est.)' : ''} <b>{run.wrs.mitigation}</b>
        </span>
        <span>
          Availability <b>{run.wrs.availability}</b>
        </span>
        <span>
          Collateral <b>{run.wrs.collateral}</b>
        </span>
      </div>
      {run.wrs.estimated ? (
        <p className="hint" style={{ marginTop: '.5rem' }}>
          Detection and Mitigation are <b>estimated</b> (no protection integration): they are
          constant, so the WRS mostly reflects measured availability.
        </p>
      ) : (
        run.protection && (
          <div className="posture">
            <div className="posture-title">
              Protection (measured by <code>{run.protection.source ?? '—'}</code>)
            </div>
            <div className="metric-grid">
              <Metric label="Time to detect (TTD)">{run.protection.detectionTimeSec}s</Metric>
              <Metric label="Time to mitigate (TTM)">{run.protection.mitigationTimeSec}s</Metric>
            </div>
          </div>
        )
      )}
      {run.acceptance && (
        <div className="posture">
          <div className="posture-title">
            SLO verdict <VerdictBadge verdict={run.acceptance.verdict} />
          </div>
          {run.acceptance.failures.length > 0 && (
            <ul className="slo-failures">
              {run.acceptance.failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {run.posture && (
        <div className="posture">
          <div className="posture-title">Protection posture (inferred from probe responses)</div>
          <div className="posture-chips">
            <span className={`chip-xs ${run.posture.waf ? 'on' : 'off'}`}>
              WAF {run.posture.waf ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.cdn ? 'on' : 'off'}`}>
              CDN {run.posture.cdn ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.rateLimiting ? 'on' : 'off'}`}>
              Rate limit {run.posture.rateLimiting ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.loadBalancer ? 'on' : 'off'}`}>
              Load balancer {run.posture.loadBalancer ? '✓' : '—'}
            </span>
            <span className={`chip-xs ${run.posture.hsts ? 'on' : 'off'}`}>
              HSTS {run.posture.hsts ? '✓' : '—'}
            </span>
          </div>
          {run.posture.server && <div className="hint">Server: {run.posture.server}</div>}
        </div>
      )}
    </div>
  );
}

/** Right-side detail panel for the campaign selected via "Details". */
export function CampaignDrawer() {
  const app = useApp();
  const id = app.expanded;
  const c = app.campaigns.find((x) => x.id === id);
  const role = app.role;
  const ar = app.authRequired;
  const canRun = c
    ? canRunCampaign(
        c,
        role,
        ar,
        app.identity?.email,
        app.requireCisoApproval,
        app.userMode,
        app.capabilities,
        app.approvalPolicy,
      )
    : false;

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') app.setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, app]);

  if (!id || !c) return null;
  const run = app.runs[c.id];
  return (
    <div className="drawer-overlay" onClick={() => app.setExpanded(null)}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Campaign details"
      >
        <div className="drawer-head">
          <div className="drawer-title">
            <span className="campaign-name">{c.name}</span>
            <StatusBadge status={c.status} />
            {app.requireCisoApproval && c.status !== 'PENDING_APPROVAL' && <CisoBadge c={c} />}
            {c.wrs && <WrsPill wrs={c.wrs} />}
            {run && <ConfidenceBadge run={run} />}
          </div>
          <button className="drawer-close" aria-label="Close" onClick={() => app.setExpanded(null)}>
            ×
          </button>
        </div>

        {c.statusDetail &&
          (c.status === 'KILLED_AUTO' ||
            c.status === 'KILLED_MANUAL' ||
            c.status === 'CANCELLED') && (
            <div className="kill-note" role="note">
              <span aria-hidden="true">🛑</span> {c.statusDetail}
            </div>
          )}

        {c.agent === 'fleet' && c.status === 'CANCELLED' && !run && (
          <DurableFleetEvidencePanel key={c.id} campaignId={c.id} />
        )}
        <div className="drawer-actions">
          {(c.drsMode || c.drsDocument) && (
            <Link
              className="btn"
              to={`/campaigns?tab=evidence&campaign=${encodeURIComponent(c.id)}`}
            >
              Prepare DRS assessment
            </Link>
          )}
          {app.approvalPolicy !== 'confirmation' &&
            c.status === 'PENDING_APPROVAL' &&
            canDo(role, 'approve', ar, app.userMode, app.capabilities) && (
              <button className="btn btn-sm" onClick={() => app.setApproveFor(c)}>
                Approve / Reject
              </button>
            )}
          {app.approvalPolicy !== 'confirmation' &&
            canCisoApprove(c, role, ar, app.capabilities) && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => app.cisoApprove(c)}
                title="Mandatory CISO sign-off (dual control)"
              >
                CISO sign-off
              </button>
            )}
          {canRun && (
            <button className="btn btn-sm btn-primary" onClick={() => app.setConfirmExec(c)}>
              Run
            </button>
          )}
          {c.status === 'RUNNING' && canDo(role, 'kill', ar, app.userMode, app.capabilities) && (
            <button
              className="btn btn-sm btn-danger"
              disabled={app.killing[c.id]}
              onClick={() => app.kill(c)}
            >
              Kill
            </button>
          )}
          {(c.status === 'PENDING_APPROVAL' || c.status === 'APPROVED') &&
            canDo(role, 'approve', ar, app.userMode, app.capabilities) && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => app.cancel(c)}
                title="Cancel this unrun campaign (terminal)"
              >
                Cancel campaign
              </button>
            )}
          {c.runId && (
            <a
              className="btn btn-sm btn-ghost"
              href={reportUrl(c.runId)}
              target="_blank"
              rel="noreferrer"
            >
              Report ↗
            </a>
          )}
        </div>

        <dl className="drawer-meta">
          <div>
            <dt>Target</dt>
            <dd>
              <code>{c.target}</code>
            </dd>
          </div>
          <div>
            <dt>Probe</dt>
            <dd>
              <code>{c.probeUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Vector</dt>
            <dd>{c.vector}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>
              {(() => {
                const configured = c.agent ?? 'server default';
                const actual = run?.engine;
                // Show the engine that actually ran; when it was auto-routed off
                // the configured one, surface both so the measurement is honest.
                const norm = (e?: string) => (e === 'builtin-http' ? 'builtin' : e);
                const actualN = norm(actual);
                if (actualN && actualN !== (c.agent ?? 'builtin')) {
                  return (
                    <>
                      {actualN}{' '}
                      <span className="hint">
                        (auto-routed from {configured} — built-in rps ceiling)
                      </span>
                    </>
                  );
                }
                return actualN ?? configured;
              })()}
            </dd>
          </div>
          <div>
            <dt>Load</dt>
            <dd>
              {c.maxRps} rps · {c.concurrency} conc · {c.maxDurationSec}s
              {c.scenario && c.scenario.length > 1 ? ` · ${c.scenario.length}-phase scenario` : ''}
            </dd>
          </div>
          <div>
            <dt>Author</dt>
            <dd>{c.createdBy}</dd>
          </div>
          {c.iotProfile && (
            <div>
              <dt>Synthetic IoT profile</dt>
              <dd>
                {c.iotProfile.id} · seed {c.iotProfile.seed} · device {c.iotProfile.deviceIndex}
                <br />
                Reproducible HTTP payload and pauses; timing depends on the environment.
              </dd>
            </div>
          )}
          {c.approvedBy && (
            <div>
              <dt>Approver</dt>
              <dd>{c.approvedBy}</dd>
            </div>
          )}
          {c.scheduledAt && (
            <div>
              <dt>{c.recurrence ? 'Next run' : 'Scheduled'}</dt>
              <dd>{new Date(c.scheduledAt).toLocaleString()}</dd>
            </div>
          )}
          {c.recurrence && (
            <div>
              <dt>Repeats</dt>
              <dd>every {formatInterval(c.recurrence.intervalMin)}</dd>
            </div>
          )}
          {c.flow && c.flow.length > 0 && (
            <div>
              <dt>Flow</dt>
              <dd>
                {c.flow.map((s, i) => {
                  let path = s.url;
                  try {
                    const u = new URL(s.url);
                    path = u.pathname + u.search;
                  } catch {
                    /* keep raw */
                  }
                  return (
                    <div key={i}>
                      <code>
                        {s.method} {path}
                      </code>
                      {s.thinkMs ? ` · think ${s.thinkMs}ms` : ''}
                      {s.extract ? ` · ⇒ {{${s.extract.name}}}` : ''}
                    </div>
                  );
                })}
              </dd>
            </div>
          )}
        </dl>

        {c.status === 'RUNNING' && <LiveProgress campaignId={c.id} agent={c.agent} />}
        {run && c.status !== 'RUNNING' && <ReplayFromRun campaign={c} run={run} />}
        {run ? (
          <RunDetails run={run} />
        ) : (
          c.status !== 'RUNNING' && (
            <p className="hint" style={{ marginTop: '.75rem' }}>
              No run yet — execute the campaign to see measured metrics and its WRS.
            </p>
          )
        )}
      </aside>
    </div>
  );
}

export function ExecuteModal() {
  const app = useApp();
  const navigate = useNavigate();
  const c = app.confirmExec;
  const [launching, setLaunching] = useState(false);
  // Reset the one-shot guard whenever a different campaign is queued for confirm.
  useEffect(() => setLaunching(false), [c?.id]);
  if (!c) return null;
  if (app.drsWorkflow && c.agent === 'fleet') return <DrsLaunchReview key={c.id} campaign={c} />;
  return (
    <Modal label="Confirm run" onClose={() => app.setConfirmExec(null)}>
      <h3>Confirm run</h3>
      <p>
        You are about to generate a bounded HTTP load of <b>{c.maxRps} rps</b> ({c.concurrency} in
        parallel) for <b>{c.maxDurationSec}s</b> against{' '}
        <span className="modal-target">{c.target}</span>. The kill switch stays available.
      </p>
      <div className="btn-row">
        <button className="btn" onClick={() => app.setConfirmExec(null)} disabled={launching}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={launching}
          onClick={() => {
            // One-shot: a fast double-click must not dispatch the run twice
            // (execute() optimistically flips the campaign to RUNNING).
            if (launching) return;
            setLaunching(true);
            // Kick off the run (blocks until it settles) and take the operator
            // straight to Run Theater's live view instead of the card drawer.
            void app.execute(c);
            app.setConfirmExec(null);
            navigate(`/theater?run=${c.id}`);
          }}
        >
          Run now
        </button>
      </div>
    </Modal>
  );
}

export function ApproveModal() {
  const app = useApp();
  const c = app.approveFor;
  const [approver, setApprover] = useState(app.identity?.email ?? app.operator);
  const [reason, setReason] = useState('');
  useEffect(
    () => setApprover(app.identity?.email ?? app.operator),
    [app.identity, app.operator, c],
  );
  if (!c) return null;
  const effective = app.authRequired ? (app.identity?.email ?? '') : approver;
  const sameAsAuthor =
    app.approvalPolicy !== 'confirmation' &&
    effective.trim() !== '' &&
    effective.trim() === c.createdBy;
  return (
    <Modal label={`Approval — ${c.name}`} onClose={() => app.setApproveFor(null)}>
      <h3>Approval — {c.name}</h3>
      <p>
        {app.approvalPolicy === 'confirmation'
          ? 'Administrator review. Explicit confirmation is still required before running.'
          : `Separation of duties: the approver must differ from the author (${c.createdBy}).`}
      </p>
      {app.authRequired ? (
        <p className="hint">
          Approver: <b>{app.identity?.email}</b>
        </p>
      ) : (
        <div className="field" style={{ marginBottom: '.75rem' }}>
          <label>Approver (Security Officer)</label>
          <input
            className={sameAsAuthor ? 'invalid' : ''}
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
          />
          {sameAsAuthor && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Must differ from the author.
            </span>
          )}
        </div>
      )}
      <div className="field">
        <label>Reason (required for rejection)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => app.setApproveFor(null)}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          disabled={sameAsAuthor || !reason.trim()}
          onClick={() => app.approve(c, effective.trim(), 'REJECTED', reason)}
        >
          Reject
        </button>
        <button
          className="btn btn-primary"
          disabled={sameAsAuthor || (!app.authRequired && !approver.trim())}
          onClick={() => app.approve(c, effective.trim(), 'APPROVED', reason)}
        >
          Approve
        </button>
      </div>
    </Modal>
  );
}

/** A password input with a show/hide toggle. The label stays `htmlFor`-associated
 *  to the input, and the input is type=password at rest (so it is not a textbox
 *  until revealed). */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw-field">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className="pw-toggle"
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          tabIndex={-1}
          onClick={() => setShow((s) => !s)}
        >
          {show ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );
}

export function Login() {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await app.login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card auth-card">
      <span className="auth-eyebrow">◎ WEDOS ShieldTest</span>
      <h2>Sign in</h2>
      <p className="auth-sub">Resilience testing control plane — authorized operators only.</p>
      {error && <p className="form-error">{error}</p>}
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <PasswordField
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? <span className="spin" /> : null}Sign in
        </button>
      </form>
      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <span className="version-tag" title={APP_BUILT ? `Built ${APP_BUILT}` : undefined}>
          {APP_VERSION_LABEL}
        </span>
      </div>
    </section>
  );
}

/**
 * Self-service password change. Used both inline in Settings and — with
 * `forced` — as the blocking gate for an admin-set temporary password. Verifies
 * the current password server-side; on success the token is rotated and other
 * sessions are revoked.
 */
export function ChangePasswordForm({
  forced = false,
  onDone,
}: {
  forced?: boolean;
  onDone?: () => void;
}) {
  const app = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await app.changeOwnPassword(current, next);
      app.push('success', 'Password changed.');
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reqs = [
    { ok: next.length >= 12, label: 'At least 12 characters' },
    { ok: next.length > 0 && next === confirm, label: 'New passwords match' },
    {
      ok: next.length > 0 && current.length > 0 && next !== current,
      label: 'Different from current',
    },
  ];
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
      {error && <p className="form-error">{error}</p>}
      <PasswordField
        id="cp-current"
        label="Current password"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <PasswordField
        id="cp-next"
        label="New password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
      />
      <PasswordField
        id="cp-confirm"
        label="Confirm new password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <ul className="pw-reqs" aria-label="Password requirements">
        {reqs.map((r) => (
          <li key={r.label} className={`pw-req${r.ok ? ' ok' : ''}`}>
            <span className="tick" aria-hidden="true">
              {r.ok ? '✓' : ''}
            </span>
            {r.label}
          </li>
        ))}
      </ul>
      <p className="hint" style={{ margin: 0 }}>
        Also avoid common passwords and your email name.
      </p>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={busy || !current || !next || !confirm}
      >
        {busy ? <span className="spin" /> : null}
        {forced ? 'Set new password & continue' : 'Change password'}
      </button>
    </form>
  );
}

/**
 * Blocking screen shown when the account carries an admin-set temporary
 * password: the operator must choose a new one before reaching the app.
 */
export function ForcedPasswordChange() {
  const app = useApp();
  return (
    <>
      <div className="accent-line" />
      <div className="app">
        <section className="card auth-card">
          <span className="auth-eyebrow">◎ Secure your account</span>
          <h2>Choose a new password</h2>
          <p className="auth-sub">
            Your account uses a temporary password{app.identity ? ` (${app.identity.email})` : ''}.
            Set your own to continue.
          </p>
          <ChangePasswordForm forced />
          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button className="btn btn-sm btn-ghost" onClick={() => app.logout()}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
