export interface BaselineDiagnosticView {
  reason: string;
  elapsedSec: number;
  observedDurationSec: number;
  samples: number;
  samplesMs: number[];
  availabilityPct: number;
  meanMs: number | null;
  coefficientOfVariation: number | null;
  tolerance: number;
  minimumSec: number;
}
export function baselineDistribution(samples: number[]) {
  const retained = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const quantile = (p: number) =>
    retained.length ? retained[Math.max(0, Math.ceil(p * retained.length) - 1)] : null;
  return {
    valid: retained.length,
    invalid: samples.length - retained.length,
    min: retained[0] ?? null,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: retained[retained.length - 1] ?? null,
  };
}
export function DrsBaselineDiagnostic({
  diagnostic,
}: {
  diagnostic?: BaselineDiagnosticView | null;
}) {
  if (!diagnostic) return null;
  const d = diagnostic,
    distribution = baselineDistribution(d.samplesMs);
  const number = (v: number | null) =>
    v === null || !Number.isFinite(v) ? 'Unknown' : v.toFixed(3);
  return (
    <section aria-label="Baseline refusal diagnostic">
      <h4>Baseline refused · {d.reason}</h4>
      <p>
        No injection was authorized by this baseline. Historical samples and the frozen tolerance
        are retained.
      </p>
      <dl>
        <dt>Observed / required duration</dt>
        <dd>
          {number(d.observedDurationSec)} / {d.minimumSec} seconds
        </dd>
        <dt>Samples reported / retained</dt>
        <dd>
          {d.samples} / {d.samplesMs.length}
        </dd>
        <dt>Availability</dt>
        <dd>{number(d.availabilityPct)}%</dd>
        <dt>Coefficient of variation / frozen tolerance</dt>
        <dd>
          {number(d.coefficientOfVariation)} / {d.tolerance}
        </dd>
        <dt>Mean latency</dt>
        <dd>{number(d.meanMs)} ms</dd>
        <dt>Retained latency min / p50 / p95 / max</dt>
        <dd>
          {[distribution.min, distribution.p50, distribution.p95, distribution.max]
            .map(number)
            .join(' / ')}{' '}
          ms
        </dd>
        <dt>Collector clock / independent vantage</dt>
        <dd>Not recorded in this diagnostic</dd>
      </dl>
      {distribution.invalid > 0 && (
        <p role="alert">
          {distribution.invalid} invalid stored samples; the distribution is incomplete.
        </p>
      )}
      {d.samplesMs.length !== d.samples && (
        <p role="alert">Retained samples do not cover every reported observation.</p>
      )}
      <details>
        <summary>Stored latency samples (ms)</summary>
        <pre>{JSON.stringify(d.samplesMs)}</pre>
      </details>
    </section>
  );
}
