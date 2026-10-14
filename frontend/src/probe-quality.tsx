import type { CampaignRun } from './api.js';

export function ProbeQualityPanel({
  probe,
  title = 'Remote probe diagnostics',
}: {
  probe: Pick<CampaignRun['probe'], 'quality'>;
  title?: string;
}) {
  const quality = probe.quality;
  if (!quality) return null;
  const value = (number: number | null | undefined, divisor: number, unit: string) =>
    typeof number === 'number' && Number.isFinite(number)
      ? `${(number / divisor).toFixed(1)} ${unit}`
      : 'unknown';
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <p className="hint">
        Resource diagnostics cover {quality.measuredSamples}/{quality.totalSamples} measurements.
        These describe the probe process and cgroup; concurrent measurements may overlap.
        {quality.eventLoopMeasuredSamples !== undefined &&
          ` Event-loop diagnostics cover ${quality.eventLoopMeasuredSamples}/${quality.totalSamples} measurements.`}
      </p>
      <dl>
        <dt>Peak event-loop delay</dt>
        <dd>{value(quality.peakEventLoopDelayMs, 1, 'ms')}</dd>
        <dt>Peak event-loop delay in recent process windows</dt>
        <dd>{value(quality.peakRecentEventLoopDelayMs, 1, 'ms')}</dd>
        <dt>Peak throttled fraction</dt>
        <dd>{value(quality.peakThrottledFraction, 0.01, '%')}</dd>
        <dt>Latest probe CPU</dt>
        <dd>
          {quality.latest
            ? value(quality.latest.cpuUserUsec + quality.latest.cpuSystemUsec, 1000, 'ms')
            : 'unknown'}
        </dd>
        <dt>Latest probe memory</dt>
        <dd>{value(quality.latest?.rssBytes, 1048576, 'MiB')}</dd>
      </dl>
    </section>
  );
}
