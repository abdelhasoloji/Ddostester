import type { CampaignRun } from '../campaigns/runner.js';
import { timelineSvg, REPORT_COLORS } from './charts.js';
import {
  cleanTimeline,
  counterIntervals,
  finalizedFailureIntervals,
  generatorObserved,
  probeCheckIntervals,
  type TimelineDatum,
} from './timeline-series.js';

/** Same retained counter transformations as Theater. No summary-derived timeline. */
export function evidenceCharts(run: CampaignRun | undefined, connections = false): string {
  if (!run) return '<p class="muted">No run measurements.</p>';
  const samples = cleanTimeline(run.timeline ?? []);
  const xMax = Math.max(1, ...samples.map((s) => s.t));
  const observed = samples.filter(generatorObserved);
  const draw = (
    caption: string,
    rows: TimelineDatum[],
    unit: string,
    max?: number,
    pointsOnly = false,
  ) =>
    `<div class="figure"><div class="cap">${caption}</div>${timelineSvg(rows, { xMax, stepped: true, pointsOnly, yMax: max, yUnit: unit, title: caption, height: 150, color: REPORT_COLORS.brand, fill: 'transparent' })}</div>`;
  const retained = (read: (s: (typeof samples)[number]) => number) =>
    samples.map((s) => ({ t: s.t, y: generatorObserved(s) ? read(s) : null }));
  let html = '';
  if (connections) {
    html += draw(
      'Connections opened (cumulative count)',
      retained((s) => s.sent),
      ' connections',
    );
    html += draw(
      'Connections closed (cumulative count; cause unproven)',
      retained((s) => s.failed),
      ' connections',
    );
  } else {
    const offered = counterIntervals(samples, (s) => s.sent);
    if (offered.some((p) => p.y != null))
      html += draw('Emitted requests per interval (req/s)', offered, ' req/s');
    else if (observed.length)
      html += draw(
        'Mean offered request rate since generator start (req/s) — legacy interval counters unavailable',
        retained((s) => s.rps),
        ' req/s',
      );
    else
      html +=
        '<p class="muted">Generator rate timeline not measured. The final summary is not a time-series.</p>';
    const successful = counterIntervals(samples, (s) => s.successful);
    if (successful.some((p) => p.y != null))
      html += draw(
        'Successful responses per interval (req/s; not target receipts)',
        successful,
        ' req/s',
      );
    const failures = finalizedFailureIntervals(samples);
    if (failures.some((p) => p.y != null))
      html += draw('Finalized request failures per interval (%)', failures, '%', 100);
  }
  const probe = probeCheckIntervals(samples);
  const probeRows = run.probe.samples > 0 ? probe.rows : probe.rows.map((p) => ({ ...p, y: null }));
  html += draw(
    probe.exact
      ? `Monitored checks (%; ${run.probe.samples} completed observations)`
      : `Probe availability (cumulative %; ${run.probe.samples} completed observations) — legacy individual outcomes unavailable`,
    probeRows,
    '%',
    100,
    true,
  );
  let lastCount: number | undefined;
  const latency = samples.map((s) => {
    const fresh = s.probeSamples == null || s.probeSamples !== lastCount;
    lastCount = s.probeSamples;
    return {
      t: s.t,
      y:
        run.probe.samples > 0 && s.probeSamples !== 0 && fresh && s.probeP95 != null
          ? s.probeP95
          : null,
    };
  });
  html += latency.some((p) => p.y != null)
    ? draw(
        'Probe latency p95 (cumulative ms over completed observations)',
        latency,
        ' ms',
        undefined,
        true,
      )
    : '<p class="muted">Probe latency timeline not recorded; aggregate latency is available separately.</p>';
  return (
    html +
    '<p class="muted">Time axis: seconds from load start. Rates use differences between observed counters. Probe dots show completed observations, not continuous uptime or per-second latency distributions. Missing data stays unobserved; counter resets break the trace. HTTP outcomes do not establish functional journeys, target receipts or protection filtering.</p>'
  );
}
