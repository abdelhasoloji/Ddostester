import { describe, it, expect } from 'vitest';
import { evidenceCharts } from '../src/modules/reports/evidence-charts.js';
import type { CampaignRun, RunSample } from '../src/modules/campaigns/runner.js';
const sample = (t: number, extra: Partial<RunSample> = {}): RunSample => ({
  t,
  rps: 0,
  sent: 0,
  failed: 0,
  probe5xx: 0,
  availPct: 100,
  ...extra,
});
const run = (timeline: RunSample[]) =>
  ({ timeline, probe: { samples: 4, available: 4 } }) as CampaignRun;
describe('faithful report timelines', () => {
  it('does not reconstruct an external engine timeline from its final summary', () => {
    const html = evidenceCharts(run([sample(1), sample(20)]));
    expect(html).toContain('Generator rate timeline not measured');
    expect(html).not.toContain('Mean offered request rate');
    expect(html).toContain('latency timeline not recorded');
  });
  it('retains measured zero, recorded p95 and cumulative sample counts', () => {
    const html = evidenceCharts(
      run([
        sample(1, { generatorObserved: true, probeSamples: 1, probeP95: 12 }),
        sample(20, { generatorObserved: true, probeSamples: 4, probeP95: 15 }),
      ]),
    );
    expect(html).toContain('Emitted requests per interval');
    expect(html).toContain('4 completed observations');
    expect(html).toContain('Probe latency p95');
    expect(html).not.toContain('timeline not measured');
    expect(html).toContain('<circle');
  });
  it('uses connection units and excludes unobserved initial points', () => {
    const html = evidenceCharts(
      run([
        sample(1, { generatorObserved: false }),
        sample(2, { sent: 100, failed: 30 }),
        sample(3, { sent: 100, failed: 40 }),
      ]),
      true,
    );
    expect(html).toContain('Connections opened');
    expect(html).not.toContain('req/s');
  });
});

it('exports unknown timeline measurements as blank fields without erasing a measured zero', async () => {
  const { runTimelineCsv } = await import('../src/modules/reports/csv.js');
  const lines = runTimelineCsv(
    run([
      sample(1, { generatorObserved: false, probeSamples: 0 }),
      sample(2, { generatorObserved: true, successful: 0, probeSamples: 1, probeP95: 10 }),
    ]),
  )
    .trim()
    .split('\n')
    .map((s) => s.split(','));
  expect(lines[1][1]).toBe('');
  expect(lines[1][5]).toBe('');
  expect(lines[2][1]).toBe('0');
  expect(lines[2][5]).toBe('100');
});

it('keeps an internal measurement gap instead of joining two observed segments', () => {
  const html = evidenceCharts(
    run([
      sample(0, { generatorObserved: true, rps: 0, sent: 0 }),
      sample(1, { generatorObserved: true, rps: 10, sent: 10 }),
      sample(2, { generatorObserved: true, rps: 12, sent: 24 }),
      sample(3, { generatorObserved: false }),
      sample(4, { generatorObserved: true, rps: 8, sent: 32 }),
      sample(5, { generatorObserved: true, rps: 9, sent: 45 }),
      sample(6, { generatorObserved: true, rps: 9, sent: 54 }),
    ]),
  );
  const firstFigure = html.split('</div></div>')[0];
  expect((firstFigure.match(/stroke-linejoin="round"/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

it('does not export a legacy placeholder availability when the run has no probe observations', async () => {
  const { runTimelineCsv } = await import('../src/modules/reports/csv.js');
  const missing = run([sample(1, { generatorObserved: false, successful: 0, probeP95: 0 })]);
  missing.probe.samples = 0;
  missing.probe.available = 0;
  const [h, v] = runTimelineCsv(missing)
    .trim()
    .split('\n')
    .map((s) => s.split(','));
  for (const key of ['availPct', 'probe5xxPct', 'probeP95Ms', 'successful'])
    expect(v[h.indexOf(key)]).toBe('');
});

it('shows completed probe checks as points, not a continuous healthy line', () => {
  const html = evidenceCharts(
    run([
      sample(0, { probeSamples: 0, probeAvailable: 0 }),
      sample(1, { probeSamples: 1, probeAvailable: 1 }),
      sample(2, { probeSamples: 1, probeAvailable: 1 }),
      sample(3, { probeSamples: 2, probeAvailable: 1 }),
    ]),
  );
  const figure = html.slice(html.indexOf('Monitored checks'), html.indexOf('Probe latency'));
  expect(figure.match(/<circle /g)).toHaveLength(2);
  expect(figure).not.toContain('<path');
  expect(html).toContain('not continuous uptime');
});
