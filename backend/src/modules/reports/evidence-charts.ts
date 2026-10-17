import type { CampaignRun, RunSample } from '../campaigns/runner.js';
import { timelineSvg, REPORT_COLORS } from './charts.js';

/** Both report types use exactly the retained samples; summaries never invent a timeline. */
export function evidenceCharts(run: CampaignRun | undefined, connections = false): string {
  if (!run) return '<p class="muted">No run measurements.</p>';
  const samples = run.timeline ?? [];
  const xMax = Math.max(1, ...samples.map((s) => s.t));
  const observed = samples.filter((s) => s.generatorObserved ?? (s.sent > 0 || s.rps > 0));
  const legacyProbe = samples.some((s) => s.probeSamples === undefined);
  const probe = samples.filter((s) => s.probeSamples !== 0 && run.probe.samples > 0);
  const draw = (
    caption: string,
    ticks: RunSample[],
    y: (s: RunSample) => number,
    unit: string,
    max?: number,
  ) =>
    `<div class="figure"><div class="cap">${caption}</div>${timelineSvg(
      ticks.map((s) => ({ t: s.t, y: y(s) })),
      {
        xMax,
        stepped: true,
        yMax: max,
        yUnit: unit,
        height: 150,
        color: REPORT_COLORS.brand,
        fill: 'transparent',
      },
    )}</div>`;
  let html = connections
    ? draw('Connections opened (cumulative count)', observed, (s) => s.sent, ' connections') +
      draw(
        'Connections closed (cumulative count; cause unproven)',
        observed,
        (s) => s.failed,
        ' connections',
      )
    : observed.length
      ? draw(
          'Mean offered request rate since generator start (req/s)',
          observed,
          (s) => s.rps,
          ' req/s',
        )
      : '<p class="muted">Generator rate timeline not measured. The final summary is not a time-series.</p>';
  html += draw(
    `Probe availability (cumulative %; ${run.probe.samples} completed observations)${legacyProbe ? ' — legacy observation times unavailable' : ''}`,
    probe,
    (s) => s.availPct,
    '%',
    100,
  );
  const latency = probe.filter((s) => s.probeP95 != null);
  html += latency.length
    ? draw(
        'Probe latency p95 (cumulative ms over completed observations)',
        latency,
        (s) => s.probeP95!,
        ' ms',
      )
    : '<p class="muted">Probe latency timeline not recorded; aggregate latency is available separately.</p>';
  return (
    html +
    '<p class="muted">Time axis: seconds from load start. Curves hold the last observed value; probe observations are not one-second independent transactions. Missing data is not zero.</p>'
  );
}
