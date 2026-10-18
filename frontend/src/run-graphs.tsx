import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { RunSample } from './api.js';
import {
  buildRunGraphs,
  graphCsv,
  panelsXMax,
  type GraphContext,
  type RunGraph,
} from './theater-graphs.js';
import { LiveLineChart } from './live-chart.js';
import { Modal } from './modal.js';
import { HelpTip } from './interface-kit.js';
import { lsGet, lsSet } from './storage.js';

const defaults = (slow: boolean) =>
  slow
    ? ['connections', 'availability', 'latency', 'quality']
    : ['load', 'availability', 'latency', 'errors'];
const validNumber = (value: string | null) =>
  value !== null && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : undefined;
function Chart({
  graph,
  range,
  height = 150,
}: {
  graph: RunGraph;
  range: [number, number];
  height?: number;
}) {
  return graph.unavailable || !graph.series.some((s) => s.points.length) ? (
    <p className="graph-empty">{graph.unavailable ?? 'No observations in this time range.'}</p>
  ) : (
    <LiveLineChart
      series={graph.series}
      xDomain={range}
      height={height}
      yRange={graph.yRange}
      stepped
      pointsOnly={graph.pointsOnly}
    />
  );
}
/** Same renderer and evidence in live runs and retained replay. Pins are display
 * preferences only; pausing freezes this view, never telemetry or execution. */
export function RunGraphs({
  timeline,
  scope = 'unscoped',
  live = false,
  ...context
}: GraphContext & { timeline: RunSample[]; scope?: string; live?: boolean }) {
  const [params, setParams] = useSearchParams();
  const slow =
    context.vector === 'http-slowloris' || timeline.some((s) => s.sampleUnit === 'connections');
  const key = 'shieldtest.graph-pins.v1.' + (slow ? 'connections' : 'http');
  const graphs = buildRunGraphs(timeline, context);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(lsGet(key) ?? 'null');
      if (Array.isArray(saved)) {
        const known = new Set(graphs.map((g) => g.id));
        const ids = [
          ...new Set(saved.filter((s): s is string => typeof s === 'string' && known.has(s))),
        ].slice(0, 4);
        if (ids.length) return ids;
      }
    } catch {
      /* Use the default view. */
    }
    return defaults(slow);
  });
  const selected =
    params.get('graphRun') === scope ? graphs.find((g) => g.id === params.get('graph')) : undefined;
  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('graph', id);
    next.set('graphRun', scope);
    setParams(next);
  };
  const close = () => {
    const next = new URLSearchParams(params);
    for (const k of [
      'graph',
      'graphRun',
      'graphUrl',
      'graphWindow',
      'graphThreshold',
      'graphFrom',
      'graphTo',
    ])
      next.delete(k);
    setParams(next, { replace: true });
  };
  const pin = (id: string) => {
    const next = pins.includes(id) ? pins.filter((v) => v !== id) : [...pins, id].slice(0, 4);
    setPins(next);
    lsSet(key, JSON.stringify(next));
  };
  const end = panelsXMax(timeline);
  return (
    <section className="run-graphs" aria-label="Run graphs">
      <div className="graphs-toolbar">
        <h3>Run graphs</h3>
        <span className="hint">
          {live ? 'Live' : 'Recorded'} · {end.toFixed(1)}s retained
        </span>
        <details className="graph-catalogue">
          <summary>Choose graphs</summary>
          <div className="graph-catalogue-list">
            <p className="hint">
              Pin up to four graphs. Missing instrumentation stays unavailable.
            </p>
            {graphs.map((g) => (
              <label key={g.id}>
                <input
                  type="checkbox"
                  checked={pins.includes(g.id)}
                  disabled={!pins.includes(g.id) && (pins.length >= 4 || !!g.unavailable)}
                  onChange={() => pin(g.id)}
                />
                <span>
                  {g.label}
                  <small>{g.unavailable ? 'Unavailable' : g.unit}</small>
                </span>
                <HelpTip label={'About ' + g.label} text={g.unavailable ?? g.note} />
              </label>
            ))}
          </div>
        </details>
      </div>
      <div className="run-metrics-grid graphs-grid">
        {pins
          .map((id) => graphs.find((g) => g.id === id))
          .filter((g): g is RunGraph => !!g)
          .map((g) => (
            <article className="run-metrics-panel" key={g.id}>
              <header className="graph-card-head">
                <span>
                  {g.label} <small>({g.unit})</small>
                </span>
                <button
                  className="btn btn-sm btn-ghost"
                  aria-label={'Open ' + g.label}
                  onClick={() => open(g.id)}
                >
                  Expand
                </button>
              </header>
              <Chart graph={g} range={[0, end]} />
              <div className="graph-card-foot">
                <span>{g.pointsOnly ? 'Completed observations' : 'Elapsed seconds'}</span>
                <HelpTip label={'About ' + g.label} text={g.note} />
              </div>
            </article>
          ))}
      </div>
      {selected && (
        <Modal label={'Graph — ' + selected.label} onClose={close} className="graph-modal">
          <GraphDetail
            key={scope + ':' + selected.id}
            id={selected.id}
            timeline={timeline}
            scope={scope}
            live={live}
            context={context}
            onClose={close}
          />
        </Modal>
      )}
    </section>
  );
}
function GraphDetail({
  id,
  timeline,
  scope,
  live,
  context,
  onClose,
}: {
  id: string;
  timeline: RunSample[];
  scope: string;
  live: boolean;
  context: GraphContext;
  onClose: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [snapshot, setSnapshot] = useState<{ timeline: RunSample[]; context: GraphContext } | null>(
    null,
  );
  const [hidden, setHidden] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const samples = snapshot?.timeline ?? timeline;
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const url = id === 'availability' ? (params.get('graphUrl') ?? '') : '';
  const graph = buildRunGraphs(samples, {
    ...(snapshot?.context ?? context),
    probeUrl: url || undefined,
  }).find((g) => g.id === id)!;
  const end = panelsXMax(samples),
    windowSec = validNumber(params.get('graphWindow'));
  const custom = params.get('graphWindow') === 'custom';
  const start = custom
    ? Math.min(validNumber(params.get('graphFrom')) ?? 0, Math.max(0, end - 0.1))
    : windowSec != null && windowSec > 0
      ? Math.max(0, end - windowSec)
      : 0;
  const finish = custom
    ? Math.max(start + 0.1, Math.min(validNumber(params.get('graphTo')) ?? end, end))
    : end;
  const threshold = validNumber(params.get('graphThreshold'));
  const lines = graph.series
    .filter((s) => !hidden.includes(s.label))
    .map((s) => ({ ...s, points: s.points.filter(([t]) => t >= start && t <= finish) }));
  if (threshold != null)
    lines.push({
      label: 'Visual threshold (not a verdict)',
      points: [
        [start, threshold],
        [finish, threshold],
      ],
      color: '#ef4444',
    });
  const view = { ...graph, series: lines };
  const urls = [...new Set(samples.flatMap((s) => s.probeEndpoints?.map((p) => p.url) ?? []))];
  const share = async () => {
    try {
      const link = new URL('/theater', window.location.origin);
      link.searchParams.set('run', scope);
      for (const key of [
        'graph',
        'graphRun',
        'graphUrl',
        'graphWindow',
        'graphThreshold',
        'graphFrom',
        'graphTo',
      ]) {
        const value = params.get(key);
        if (value) link.searchParams.set(key, value);
      }
      await navigator.clipboard.writeText(link.toString());
      setNotice('Graph link copied. Paused snapshots are not included.');
    } catch {
      setNotice('Link could not be copied; the current graph parameters are in the address bar.');
    }
  };
  const csv = () => {
    const blob = new Blob(
      [
        graphCsv({
          ...view,
          series: lines.filter((s) => s.label !== 'Visual threshold (not a verdict)'),
        }),
      ],
      { type: 'text/csv;charset=utf-8' },
    );
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `run-${scope.replace(/[^a-zA-Z0-9-]/g, '_')}-${id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const firstGenerator = samples.find((s) => s.generatorObserved ?? s.sent > 0);
  const firstProbe = samples.find((s) => (s.probeSamples ?? 0) > 0);
  return (
    <>
      <header className="graph-detail-head">
        <div>
          <h2>
            {graph.label} <small>({graph.unit})</small>
          </h2>
          <span className="hint">
            {snapshot
              ? 'Paused view · collection continues'
              : live
                ? 'Live observations'
                : 'Retained observations'}
          </span>
        </div>
        <button className="btn btn-sm" onClick={onClose}>
          Close graph
        </button>
      </header>
      <div className="graph-detail-controls">
        {live && (
          <button
            className="btn btn-sm"
            onClick={() => setSnapshot(snapshot ? null : structuredClone({ timeline, context }))}
          >
            {snapshot ? 'Resume live' : 'Pause view'}
          </button>
        )}
        <label>
          Time range
          <select
            value={params.get('graphWindow') ?? ''}
            onChange={(e) => update('graphWindow', e.target.value)}
          >
            <option value="">Whole run</option>
            <option value="30">Last 30 seconds</option>
            <option value="60">Last 60 seconds</option>
            <option value="120">Last 120 seconds</option>
            <option value="custom">Custom interval</option>
          </select>
        </label>
        {custom && (
          <>
            <label>
              From (s)
              <input
                type="number"
                min="0"
                max={end}
                value={params.get('graphFrom') ?? ''}
                onChange={(e) => update('graphFrom', e.target.value)}
              />
            </label>
            <label>
              To (s)
              <input
                type="number"
                min="0"
                max={end}
                value={params.get('graphTo') ?? ''}
                onChange={(e) => update('graphTo', e.target.value)}
              />
            </label>
          </>
        )}
        {id === 'availability' && (
          <label>
            Monitored URL
            <select value={url} onChange={(e) => update('graphUrl', e.target.value)}>
              <option value="">All monitored checks</option>
              {urls.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        )}
        {graph.unit !== 'count / seconds' && (
          <label>
            Visual threshold ({graph.unit})
            <input
              aria-label="Visual threshold"
              type="number"
              min="0"
              step="any"
              value={params.get('graphThreshold') ?? ''}
              onChange={(e) => update('graphThreshold', e.target.value)}
            />
          </label>
        )}
        <button
          className="btn btn-sm"
          disabled={graph.unavailable !== undefined || !lines.some((s) => s.points.length)}
          onClick={csv}
        >
          Export graph CSV
        </button>
        <button className="btn btn-sm" disabled={scope === 'unscoped'} onClick={() => void share()}>
          Copy graph link
        </button>
      </div>
      <p className="hint">{graph.note}</p>
      <div className="graph-detail-chart">
        <Chart graph={view} range={[start, finish]} height={300} />
      </div>
      <div className="graph-series" aria-label="Visible series">
        {graph.series.map((s) => (
          <label key={s.label}>
            <input
              type="checkbox"
              checked={!hidden.includes(s.label)}
              onChange={() =>
                setHidden(
                  hidden.includes(s.label)
                    ? hidden.filter((v) => v !== s.label)
                    : [...hidden, s.label],
                )
              }
            />
            {s.label}
          </label>
        ))}
      </div>
      <div className="graph-evidence-strip">
        <span>{samples.length} retained timeline points</span>
        <span>{samples.at(-1)?.probeSamples ?? 'Unknown'} completed probe cycles</span>
        <span>
          {start.toFixed(1)}–{finish.toFixed(1)}s
        </span>
      </div>
      <details>
        <summary>Observation markers</summary>
        <ul>
          {firstGenerator && (
            <li>First observed generator counters: {firstGenerator.t.toFixed(1)}s</li>
          )}
          {firstProbe && <li>First retained probe observation: {firstProbe.t.toFixed(1)}s</li>}
          <li>These markers are observations, not detection, mitigation or recovery timestamps.</li>
        </ul>
      </details>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
