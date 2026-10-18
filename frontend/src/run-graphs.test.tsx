import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunGraphs } from './run-graphs.js';
import { buildRunGraphs, graphCsv, intervalPoints } from './theater-graphs.js';
import type { RunSample } from './api.js';
const tick = (t: number, sent: number, successful: number, failed: number): RunSample => ({
  t,
  sent,
  successful,
  failed,
  rps: sent / t,
  probe5xx: 0,
  availPct: 100,
  generatorObserved: true,
  probeSamples: t,
  probeAvailable: t,
  probeLatencyMs: { p50: 10, p95: 20, p99: 30 },
  statusCounts: { '2xx': successful, '5xx': failed },
  probeEndpoints: [{ url: 'http://lab.example/health', samples: t, available: t }],
  probeP95: 20,
});
const samples = [tick(1, 10, 10, 0), tick(2, 40, 38, 2)];
beforeEach(() => localStorage.clear());
describe('evidence-based graph transformations', () => {
  it('shows interval bursts rather than hiding them in cumulative means, excluding resets and unobserved ticks', () => {
    expect(intervalPoints(samples, (s) => s.sent)).toEqual([[2, 30]]);
    expect(intervalPoints([...samples, tick(3, 5, 5, 0)], (s) => s.sent)).toEqual([[2, 30]]);
    expect(
      intervalPoints([samples[0], { ...samples[1], generatorObserved: false }], (s) => s.sent),
    ).toEqual([]);
  });
  it('denominates failures by finalized outcomes, including late outcomes without new emission', () => {
    const points = buildRunGraphs([tick(1, 10, 0, 0), tick(2, 10, 8, 2)]).find(
      (g) => g.id === 'errors',
    )!.series[0].points;
    expect(points).toEqual([[2, 20]]);
  });
  it('retains only new probe observations and filters the selected URL without claiming continuous uptime', () => {
    const input = [
      samples[0],
      {
        ...samples[1],
        probeSamples: 1,
        probeAvailable: 1,
        probeEndpoints: samples[0].probeEndpoints,
      },
      {
        ...tick(3, 50, 48, 2),
        probeEndpoints: [{ url: 'http://lab.example/health', samples: 2, available: 1 }],
      },
    ];
    const g = buildRunGraphs(input, { probeUrl: 'http://lab.example/health' }).find(
      (g) => g.id === 'availability',
    )!;
    expect(g.pointsOnly).toBe(true);
    expect(g.series[0].points).toEqual([
      [1, 100],
      [3, 0],
    ]);
  });
  it('does not invent percentiles, target metrics or source diversity from generator results', () => {
    const old = samples.map((s) => ({ ...s, probeLatencyMs: undefined, probeP95: undefined }));
    const graphs = buildRunGraphs(old);
    expect(graphs.find((g) => g.id === 'latency')?.unavailable).toBeTruthy();
    for (const id of ['received', 'fleet', 'target-cpu', 'generator-health', 'recovery'])
      expect(graphs.find((g) => g.id === id)?.unavailable).toBeTruthy();
  });
  it('omits the primary-URL baseline for multi-URL aggregates', () => {
    const multi = samples.map((s) => ({
      ...s,
      probeEndpoints: [
        ...s.probeEndpoints!,
        {
          url: 'http://lab.example/secondary',
          samples: s.probeSamples!,
          available: s.probeSamples!,
        },
      ],
    }));
    const latency = buildRunGraphs(multi, { baselineP95: 15 }).find((g) => g.id === 'latency')!;
    expect(latency.series.map((s) => s.label)).not.toContain('Pre-load baseline p95');
    const historical = buildRunGraphs(
      samples.map((s) => ({ ...s, probeEndpoints: undefined })),
      { baselineP95: 15 },
    ).find((g) => g.id === 'latency')!;
    expect(historical.series.map((s) => s.label)).not.toContain('Pre-load baseline p95');
  });
  it('does not map connection counters to request rate or failures', () => {
    const graphs = buildRunGraphs(samples, { vector: 'http-slowloris' });
    expect(graphs.find((g) => g.id === 'load')?.unavailable).toBeTruthy();
    expect(graphs.find((g) => g.id === 'connections')?.series[0].points).toHaveLength(2);
  });
  it('exports actual observations and neutralizes spreadsheet formulas in labels', () => {
    expect(
      graphCsv({
        id: 'x',
        label: 'x',
        unit: 'ms',
        note: '',
        series: [{ label: '=1+1', points: [[2, 10]] }],
      }),
    ).toContain('"\'=1+1"');
  });
});
describe('individual graph workflow', () => {
  it('opens only the chosen campaign graph, freezes the view without stopping data collection, and restores focus', () => {
    const view = (ticks: RunSample[]) => (
      <MemoryRouter>
        <RunGraphs timeline={ticks} scope="c1" live />
        <RunGraphs timeline={samples} scope="c2" live />
      </MemoryRouter>
    );
    const result = render(view(samples));
    const trigger = screen.getAllByRole('button', { name: 'Open Load per interval' })[0];
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause view' }));
    result.rerender(view([...samples, tick(3, 70, 67, 3)]));
    expect(within(screen.getByRole('dialog')).getByText('0.0–2.0s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume live' }));
    expect(within(screen.getByRole('dialog')).getByText('0.0–3.0s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close graph' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('breaks visible rate strokes across unavailable measurements instead of implying delivery', () => {
    render(
      <MemoryRouter>
        <RunGraphs
          timeline={[
            tick(0, 0, 0, 0),
            tick(1, 10, 10, 0),
            { ...tick(2, 20, 20, 0), generatorObserved: false },
            tick(3, 30, 30, 0),
            tick(4, 40, 40, 0),
          ]}
          scope="gapped"
        />
      </MemoryRouter>,
    );
    const card = screen.getByRole('button', { name: 'Open Load per interval' }).closest('article')!;
    const path = card.querySelector('.lc-line')!.getAttribute('d')!;
    expect(path.match(/M/g)).toHaveLength(2);
    expect(card.querySelector('.lc-area')).toBeNull();
    expect(card.querySelectorAll('.lc-dot').length).toBeGreaterThanOrEqual(2);
  });
  it('reopens a graph from a deep link and exposes URL selection, thresholds and unavailable instrumentation', () => {
    render(
      <MemoryRouter initialEntries={['/theater?run=c1&graph=availability&graphRun=c1']}>
        <RunGraphs timeline={samples} scope="c1" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'Graph — Monitored checks' })).toBeInTheDocument();
    expect(screen.getByLabelText('Monitored URL')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Monitored URL'), {
      target: { value: 'http://lab.example/health' },
    });
    fireEvent.change(screen.getByLabelText('Visual threshold'), { target: { value: '90' } });
    expect(screen.getByText('Visual threshold (not a verdict)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From (s)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('To (s)'), { target: { value: '2' } });
    expect(screen.getByText('1.0–2.0s')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close graph' }));
    fireEvent.click(screen.getByText('Choose graphs'));
    expect(screen.getByRole('checkbox', { name: /Received load/ })).toBeDisabled();
  });
});
