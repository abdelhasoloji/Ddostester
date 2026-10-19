import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Live runtime/operational metrics, maintained in-process and exposed via
 * /metrics alongside the business metrics (renderMetrics). Dependency-free
 * Prometheus text (0.0.4). Complements the on-demand business gauges with the
 * signals that make the system observable at runtime: HTTP throughput/latency,
 * in-flight and completed runs, the load engine's hard-stop counter (a run that
 * outlived its cap because the target tarpitted), and event-loop lag (a spike
 * here is what briefly made the API unreachable under heavy load).
 */

type Labels = Record<string, string>;

function labelKey(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return JSON.stringify(
    Object.keys(labels)
      .sort()
      .map((k) => [k, labels[k]]),
  );
}
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
function renderLabels(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const inner = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(String(labels[k]))}"`)
    .join(',');
  return `{${inner}}`;
}

interface Series {
  labels?: Labels;
  value: number;
}
interface Summary {
  labels?: Labels;
  count: number;
  sum: number;
}

class Registry {
  private counters = new Map<string, Map<string, Series>>();
  private gauges = new Map<string, Map<string, Series>>();
  private summaries = new Map<string, Map<string, Summary>>();
  private help = new Map<string, string>();
  private readonly eld = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.eld.enable();
  }

  private describe(name: string, help: string): void {
    if (!this.help.has(name)) this.help.set(name, help);
  }

  inc(name: string, help: string, labels?: Labels, by = 1): void {
    this.describe(name, help);
    const key = labelKey(labels);
    const m = this.counters.get(name) ?? new Map<string, Series>();
    const s = m.get(key) ?? { labels, value: 0 };
    s.value += by;
    m.set(key, s);
    this.counters.set(name, m);
  }

  setGauge(name: string, help: string, value: number, labels?: Labels): void {
    this.describe(name, help);
    const key = labelKey(labels);
    const m = this.gauges.get(name) ?? new Map<string, Series>();
    m.set(key, { labels, value });
    this.gauges.set(name, m);
  }

  addGauge(name: string, help: string, by: number, labels?: Labels): void {
    this.describe(name, help);
    const key = labelKey(labels);
    const m = this.gauges.get(name) ?? new Map<string, Series>();
    const s = m.get(key) ?? { labels, value: 0 };
    s.value += by;
    m.set(key, s);
    this.gauges.set(name, m);
  }

  /**
   * Removes a gauge series (one label set), or the whole metric when `labels` is
   * omitted. Used to retire the live per-run gauges when a run ends, so a
   * finished run's last live value never lingers as a stale flat line.
   */
  clearGauge(name: string, labels?: Labels): void {
    const m = this.gauges.get(name);
    if (!m) return;
    if (labels === undefined) {
      this.gauges.delete(name);
      return;
    }
    m.delete(labelKey(labels));
    if (m.size === 0) this.gauges.delete(name);
  }

  /** Records a duration/size observation (rendered as a Prometheus summary: _count + _sum). */
  observe(name: string, help: string, value: number, labels?: Labels): void {
    this.describe(name, help);
    const key = labelKey(labels);
    const m = this.summaries.get(name) ?? new Map<string, Summary>();
    const s = m.get(key) ?? { labels, count: 0, sum: 0 };
    s.count += 1;
    s.sum += value;
    m.set(key, s);
    this.summaries.set(name, m);
  }

  /**
   * Current event-loop delay mean (ms), non-destructive (does NOT reset the
   * histogram, unlike render()). Used by in-process integrity checks — the
   * scheduler guardrail and per-run measurement-confidence — to tell whether the
   * generator host itself is the bottleneck. Returns 0 before any samples.
   */
  eventLoopLagMs(): number {
    const v = this.eld.mean / 1e6;
    return Number.isFinite(v) ? v : 0;
  }

  render(): string {
    const lines: string[] = [];
    // Process + event-loop snapshot (sampled at scrape time).
    const mem = process.memoryUsage();
    this.setGauge('shieldtest_process_uptime_seconds', 'Process uptime', process.uptime());
    this.setGauge('shieldtest_process_heap_used_bytes', 'V8 heap used', mem.heapUsed);
    this.setGauge('shieldtest_process_rss_bytes', 'Resident set size', mem.rss);
    // Event-loop delay (ms) — mean and p99 since last scrape, then reset. Guard
    // against NaN when the histogram has no samples yet.
    const finite = (v: number): number => (Number.isFinite(v) ? v : 0);
    this.setGauge(
      'shieldtest_eventloop_lag_ms',
      'Event-loop delay mean (ms) since last scrape',
      finite(this.eld.mean / 1e6),
    );
    this.setGauge(
      'shieldtest_eventloop_lag_p99_ms',
      'Event-loop delay p99 (ms) since last scrape',
      finite(this.eld.percentile(99) / 1e6),
    );
    this.eld.reset();

    for (const [name, m] of this.counters) {
      lines.push(`# HELP ${name} ${this.help.get(name) ?? ''}`);
      lines.push(`# TYPE ${name} counter`);
      for (const s of m.values()) lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const [name, m] of this.gauges) {
      lines.push(`# HELP ${name} ${this.help.get(name) ?? ''}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const s of m.values()) lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const [name, m] of this.summaries) {
      lines.push(`# HELP ${name} ${this.help.get(name) ?? ''}`);
      lines.push(`# TYPE ${name} summary`);
      for (const s of m.values()) {
        lines.push(`${name}_count${renderLabels(s.labels)} ${s.count}`);
        lines.push(`${name}_sum${renderLabels(s.labels)} ${s.sum}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

/** Process-wide runtime metrics registry. */
export const metrics = new Registry();
