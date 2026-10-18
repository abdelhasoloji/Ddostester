import { describe, it, expect } from 'vitest';
import { metrics } from '../src/modules/metrics/runtime.js';

describe('runtime metrics registry', () => {
  it('keeps delimiter-containing label sets distinct and clears only the requested series', () => {
    metrics.setGauge('test_collision', 'labels', 1, { a: 'x,b=y' });
    metrics.setGauge('test_collision', 'labels', 2, { a: 'x', b: 'y' });
    expect(metrics.render()).toContain('test_collision{a="x,b=y"} 1');
    expect(metrics.render()).toContain('test_collision{a="x",b="y"} 2');
    metrics.clearGauge('test_collision', { a: 'x,b=y' });
    expect(metrics.render()).not.toContain('test_collision{a="x,b=y"}');
    expect(metrics.render()).toContain('test_collision{a="x",b="y"} 2');
  });
  it('renders counters, gauges and summaries in Prometheus text', () => {
    metrics.inc('test_things_total', 'A test counter', { kind: 'a' });
    metrics.inc('test_things_total', 'A test counter', { kind: 'a' });
    metrics.inc('test_things_total', 'A test counter', { kind: 'b' });
    metrics.setGauge('test_in_flight', 'A test gauge', 3, { target: 'x' });
    metrics.observe('test_duration_seconds', 'A test summary', 1.5);
    metrics.observe('test_duration_seconds', 'A test summary', 2.5);

    const out = metrics.render();

    // Counter with per-label values.
    expect(out).toContain('# TYPE test_things_total counter');
    expect(out).toContain('test_things_total{kind="a"} 2');
    expect(out).toContain('test_things_total{kind="b"} 1');
    // Gauge.
    expect(out).toContain('# TYPE test_in_flight gauge');
    expect(out).toContain('test_in_flight{target="x"} 3');
    // Summary → _count + _sum.
    expect(out).toContain('# TYPE test_duration_seconds summary');
    expect(out).toContain('test_duration_seconds_count 2');
    expect(out).toContain('test_duration_seconds_sum 4');
    // Runtime process + event-loop signals are always present.
    expect(out).toContain('shieldtest_eventloop_lag_ms');
    expect(out).toContain('shieldtest_process_heap_used_bytes');
    expect(out).not.toMatch(/NaN|undefined/);
  });

  it('addGauge increments/decrements an in-flight gauge (run tracking)', () => {
    metrics.addGauge('test_active', 'active', 1, { g: '1' });
    metrics.addGauge('test_active', 'active', 1, { g: '1' });
    metrics.addGauge('test_active', 'active', -1, { g: '1' });
    expect(metrics.render()).toContain('test_active{g="1"} 1');
  });

  it('clearGauge retires a live series (per label set) so no stale line lingers', () => {
    metrics.setGauge('test_live_rps', 'live', 42, { target: 'a', vector: 'http-get' });
    metrics.setGauge('test_live_rps', 'live', 7, { target: 'b', vector: 'http-get' });
    expect(metrics.render()).toContain('test_live_rps{target="a",vector="http-get"} 42');

    // Clear only the 'a' series — 'b' survives.
    metrics.clearGauge('test_live_rps', { target: 'a', vector: 'http-get' });
    const out = metrics.render();
    expect(out).not.toContain('test_live_rps{target="a"');
    expect(out).toContain('test_live_rps{target="b",vector="http-get"} 7');

    // Clearing an unknown metric/label set is a safe no-op.
    expect(() => metrics.clearGauge('test_live_rps', { target: 'zzz' })).not.toThrow();
    expect(() => metrics.clearGauge('does_not_exist')).not.toThrow();
  });
});
