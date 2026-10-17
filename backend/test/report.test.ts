import { describe, expect, it } from 'vitest';
import { renderCampaignReportHtml } from '../src/modules/reports/report.js';
import { runsSummaryCsv } from '../src/modules/reports/csv.js';

it('uses the same generator window for offered and successful response rates', () => {
  const observed = run();
  observed.generator.totalRequests = 16000;
  observed.generator.successful = 16000;
  observed.generator.failed = 0;
  observed.generator.actualRps = 800;
  observed.generator.statusCounts = { '2xx': 16000 };
  const html = renderCampaignReportHtml(campaign(), observed);
  expect(html).toContain('~800 req/s');
});

it('counts transport outcomes instead of counting distinct Vegeta error messages', () => {
  const observed = run();
  observed.generator.statusCounts = { '2xx': 167, '5xx': 169, '0xx': 3410 };
  observed.generator.errors = { EOF: 1, '504 Gateway Time-out': 1 };
  observed.generator.failed = 3579;
  const html = renderCampaignReportHtml(campaign(), observed);
  expect(html).toContain('169 HTTP failures (4xx/5xx)');
  expect(html).toContain('3,410 transport failures (cause unproven)');
  expect(html).not.toContain('3,579 rejected by the edge');
  expect(html).not.toContain('Mitigation caused collateral damage');
});

it('exports missing latency as unknown rather than zero milliseconds', () => {
  const interrupted = run();
  interrupted.generator.latencySampleCount = 0;
  expect(renderCampaignReportHtml(campaign(), interrupted)).toContain('Generator latency unknown');
  const [headers, values] = runsSummaryCsv([interrupted])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('latencyP95Ms')]).toBe('');
});

it('records the latency aggregation method without retroactively labeling old runs', () => {
  const combined = run();
  combined.generator.latencyMethod = 'native-combined-results';
  expect(renderCampaignReportHtml(campaign(), combined)).toContain(
    'phase percentiles are not averaged',
  );
  const [headers, values] = runsSummaryCsv([combined])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('generatorLatencyMethod')]).toBe('native-combined-results');
  expect(renderCampaignReportHtml(campaign(), run())).not.toContain(
    'Generator latency aggregation',
  );
});

it('exports unfinalized outcomes without inferring target receipts or statuses', () => {
  const incomplete = run();
  incomplete.generator.finalizedRequests = 29999;
  incomplete.generator.unfinalizedRequests = 1;
  const html = renderCampaignReportHtml(campaign(), incomplete);
  expect(html).toContain('29999 / 1');
  expect(html).toContain('no inferred target receipt or HTTP status');
  expect(html).toContain('Measurement degraded');
  const [headers, values] = runsSummaryCsv([incomplete])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('unfinalizedRequests')]).toBe('1');
  expect(values[headers.indexOf('finalizedRequests')]).toBe('29999');
});

it('identifies the synthetic profile and reproducibility limits in the report', () => {
  const recorded = run();
  recorded.generator.config = {
    url: 'http://127.0.0.1/',
    concurrency: 1,
    durationSec: 2,
    maxRps: 2,
    authorized: true,
    iotProfile: { id: 'sensor-heartbeat/v1', seed: 42, deviceIndex: 7 },
  };
  const html = renderCampaignReportHtml(
    campaign({
      iotProfile: {
        id: 'sensor-heartbeat/v1',
        seed: 99,
        deviceIndex: 8,
      },
    }),
    recorded,
  );
  expect(html).toContain('Profile sensor-heartbeat/v1 · seed 42 · device index 7');
  expect(html).toContain('not reproducible firmware or network emulation');
  expect(html).not.toContain('seed 99');
  const [headers, values] = runsSummaryCsv([recorded])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('iotProfile')]).toBe('sensor-heartbeat/v1');
  expect(values[headers.indexOf('iotSeed')]).toBe('42');
  expect(values[headers.indexOf('iotDeviceIndex')]).toBe('7');
  const legacy = renderCampaignReportHtml(
    campaign({ iotProfile: recorded.generator.config.iotProfile }),
    run(),
  );
  expect(legacy).not.toContain('<h2>Synthetic IoT profile</h2>');
  const [legacyHeaders, legacyValues] = runsSummaryCsv([run()])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(legacyValues[legacyHeaders.indexOf('iotProfile')]).toBe('');
});

it('leaves global counters unknown when fleet final reports are missing', () => {
  const missing = run();
  missing.generator.fleet = {
    measurementComplete: false,
    shards: [{ agentId: 'one', state: 'LOST', attemptId: 'a', leaseUntil: 0 }],
  };
  missing.generator.totalRequests = 0;
  const html = renderCampaignReportHtml(campaign(), missing);
  expect(html).toContain('Reported requests (partial)');
  expect(html).toContain('0/1 final reports');
  const [headers, values] = runsSummaryCsv([missing])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('requests')]).toBe('');
  expect(values[headers.indexOf('reportedRequests')]).toBe('0');
  expect(values[headers.indexOf('fleetReportedAgents')]).toBe('0');
});
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

it('exports unknown probe diagnostics separately from measured zero throttling', () => {
  const measured = run();
  measured.probe.quality = {
    measuredSamples: 90,
    totalSamples: 120,
    peakEventLoopDelayMs: null,
    peakThrottledFraction: 0,
    peakRecentEventLoopDelayMs: 175,
  };
  const html = renderCampaignReportHtml(campaign(), measured);
  expect(html).toContain('90/120 measurements');
  expect(html).toContain('Probe event-loop delay peak</th><td>unknown');
  const [headers, values] = runsSummaryCsv([measured])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('probeDiagnosticSamples')]).toBe('90');
  expect(values[headers.indexOf('probeEventLoopDelayPeakMs')]).toBe('');
  expect(values[headers.indexOf('probeThrottledFractionPeak')]).toBe('0');
  expect(values[headers.indexOf('probeRecentEventLoopDelayPeakMs')]).toBe('175');
  expect(html).toContain('Probe recent process-window event-loop delay peak</th><td>175 ms');
});

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c-1',
    name: 'Baseline probe',
    target: 'https://staging.example.com/',
    probeUrl: 'https://staging.example.com/health',
    vector: 'http-get',
    createdBy: 'eng@wedos',
    approvedBy: 'off@wedos',
    maxRps: 300,
    concurrency: 50,
    maxDurationSec: 120,
    ...over,
  } as unknown as Campaign;
}

function run(over: Record<string, unknown> = {}): CampaignRun {
  const timeline = Array.from({ length: 12 }, (_, t) => ({
    t,
    rps: t * 25,
    sent: t * 100,
    failed: t,
    probe5xx: 0,
    availPct: 100,
  }));
  return {
    runId: 'run-abcdef12-0000',
    campaignId: 'c-1',
    status: 'COMPLETED',
    generator: {
      totalRequests: 30000,
      successful: 29900,
      failed: 100,
      actualRps: 250,
      finishedAt: new Date().toISOString(),
      latencyMs: { p50: 40, p95: 150, p99: 400 },
    },
    probe: {
      samples: 120,
      available: 120,
      errorRate5xx: 0,
      latencyMs: { p50: 55, p95: 200, p99: 500 },
    },
    wrs: {
      wrs: 88,
      level: 'A',
      detection: 0.7,
      mitigation: 0.7,
      availability: 1,
      collateral: 0.95,
      estimated: false,
    },
    timeline,
    ...over,
  } as unknown as CampaignRun;
}

describe('per-campaign report', () => {
  const html = renderCampaignReportHtml(campaign(), run());

  it('renders the designed sections and charts', () => {
    expect(html).toContain('Campaign resilience report');
    expect(html).toContain('Confidential — WEDOS internal');
    expect(html).toContain('class="lead"'); // management summary
    expect(html).toContain('At a glance');
    expect(html).toContain('chart-gauge'); // WRS gauge
    expect(html).toContain('Traffic over time');
    expect(html).toContain('chart-timeline'); // rps + availability timelines
    expect(html).toContain('chart-hbars'); // WRS components + latency
    expect(html).toContain('Latency profile');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('summarises the run in prose with the score and availability', () => {
    expect(html).toMatch(/WRS 88 \(A\)/);
    expect(html).toContain('req/s');
    expect(html).toContain('availability held');
  });

  it('shows the kill callout and estimated caveat when applicable', () => {
    const killed = renderCampaignReportHtml(
      campaign(),
      run({
        status: 'KILLED_AUTO',
        statusDetail: 'Auto-killed: target unavailable ≥30 s.',
        wrs: {
          wrs: 40,
          level: 'F',
          detection: 0.5,
          mitigation: 0.5,
          availability: 0.3,
          collateral: 0.6,
          estimated: true,
        },
        probe: {
          samples: 60,
          available: 20,
          errorRate5xx: 30,
          latencyMs: { p50: 200, p95: 900, p99: 2000 },
        },
      }),
    );
    expect(killed).toContain('Auto-killed: target unavailable');
    expect(killed).toContain('WRS estimated');
    expect(killed).not.toMatch(/NaN|undefined/);
  });

  it('degrades gracefully when a run has no timeline', () => {
    const noTl = renderCampaignReportHtml(campaign(), run({ timeline: [] }));
    expect(noTl).toContain('No time-series captured');
    expect(noTl).not.toMatch(/NaN|undefined/);
  });

  it('explains a flood the target absorbed (low success + heavy throttle), not just the score', () => {
    const blocked = renderCampaignReportHtml(
      campaign({ maxRps: 500, name: 'Random-URL wave' }),
      run({
        generator: {
          totalRequests: 2028,
          successful: 0,
          failed: 2028,
          actualRps: 11,
          finishedAt: new Date().toISOString(),
          latencyMs: { p50: 6500, p95: 9600, p99: 9950 },
          statusCounts: { '4xx': 511 },
          errors: { AbortError: 1517 },
        },
        timeline: Array.from({ length: 12 }, (_, t) => ({
          t,
          rps: 11,
          sent: t * 11,
          failed: t * 11,
          probe5xx: 0,
          availPct: 100,
        })),
      }),
    );
    // Faithful: only ~11/500 req/s was delivered — a generator-side shortfall, so
    // the engine calls this INCONCLUSIVE (not "protection absorbed"), not left bare.
    expect(blocked).toContain('Inconclusive — not a valid test at the target rate');
    expect(blocked).toMatch(/Delivered only \d+% of the intended offered rate/);
    // Configured intent is still shown in the absorption section.
    expect(blocked).toContain('Configured load');
    expect(blocked).toMatch(/500 req\/s/);
    expect(blocked).not.toMatch(/NaN|undefined/);
  });
});

describe('renderCampaignReportHtml — template applicability (requires → N/A)', () => {
  it('marks a required feature N/A when the recon snapshot shows the target lacks it', () => {
    const html = renderCampaignReportHtml(
      campaign({
        requires: ['waf'],
        reconPosture: { h2: false, waf: false, cache: false, dynamic: true },
      }),
      run(),
    );
    expect(html).toContain('Template applicability');
    expect(html).toContain('WAF / bot-management');
    expect(html).toContain('N/A');
    expect(html).toContain('not resistance');
  });

  it('marks a required feature as applying when the target exhibits it', () => {
    const html = renderCampaignReportHtml(
      campaign({
        requires: ['cache'],
        reconPosture: { h2: false, waf: false, cache: true, dynamic: false },
      }),
      run(),
    );
    expect(html).toContain('Template applicability');
    expect(html).toContain('applies');
    // A satisfied requirement is not flagged N/A.
    expect(html).not.toContain('a benign result here is not resistance');
  });

  it('renders no applicability block for a template with no requirements', () => {
    const html = renderCampaignReportHtml(campaign(), run());
    expect(html).not.toContain('Template applicability');
  });

  it('falls back to "not recorded" for h2 when no recon posture was captured', () => {
    const html = renderCampaignReportHtml(campaign({ requires: ['h2'] }), run());
    expect(html).toContain('Template applicability');
    expect(html).toContain('not recorded');
  });
});

it('labels missing baseline observations and suppresses contradictory stored comparisons', () => {
  const incomplete = run();
  incomplete.baseline = {
    samples: 3,
    availabilityPct: 0,
    latencyMs: { p50: 0, p95: 0 },
    observation: {
      vantage: 'remote',
      expectedSamples: 3,
      receivedSamples: 0,
      missingSamples: 3,
      complete: false,
    },
  };
  incomplete.baselineDelta = {
    latencyP50DeltaMs: 1,
    latencyP95DeltaMs: 2,
    availabilityDeltaPct: 100,
  };
  const html = renderCampaignReportHtml(campaign(), incomplete);
  expect(html).toContain('Remote baseline incomplete');
  expect(html).toContain('0/3 observations received');
  expect(html).not.toContain('Degradation under load vs baseline');
  expect(html).not.toContain('p95 latency shifted by');
});

it('exports baseline resource scope independently of under-load probe quality', () => {
  const measured = run();
  measured.baseline = {
    samples: 3,
    availabilityPct: 100,
    latencyMs: { p50: 10, p95: 20 },
    quality: {
      measuredSamples: 2,
      totalSamples: 3,
      eventLoopMeasuredSamples: 2,
      peakEventLoopDelayMs: null,
      peakRecentEventLoopDelayMs: 175,
      peakThrottledFraction: 0,
    },
  };
  const html = renderCampaignReportHtml(campaign(), measured);
  expect(html).toContain('Baseline diagnostic coverage</th><td>2/3');
  expect(html).toContain('Baseline recent process-window event-loop delay peak</th><td>175 ms');
  const [headers, values] = runsSummaryCsv([measured])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('baselineDiagnosticSamples')]).toBe('2');
  expect(values[headers.indexOf('baselineRecentEventLoopDelayPeakMs')]).toBe('175');
  expect(values[headers.indexOf('baselineThrottledFractionPeak')]).toBe('0');
});

it('identifies suite recovery as a before-step observation in HTML and CSV', () => {
  const measured = run();
  measured.recoveryBeforeRun = { available: true, verified: true, checks: 2, waitedMs: 1250 };
  const html = renderCampaignReportHtml(campaign(), measured);
  expect(html).toContain('Recovery before suite step');
  expect(html).toContain('2 checks');
  const [headers, values] = runsSummaryCsv([measured])
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  expect(values[headers.indexOf('recoveryBeforeRunVerified')]).toBe('true');
  expect(values[headers.indexOf('recoveryBeforeRunChecks')]).toBe('2');
});

it('keeps missing probe evidence unknown and distinguishes a mean rate from an instantaneous peak', () => {
  const observed = run();
  observed.probe.samples = 0;
  const html = renderCampaignReportHtml(campaign(), observed);
  expect(html).toContain('Not measured');
  expect(html).toContain('Probe latency unknown');
  expect(html).toContain('verdict <b>inconclusive');
  expect(html).toContain('maximum recorded mean (not instantaneous peak)');
  expect(html).not.toContain('Achieved peak');
});

it('describes a slow-header run in connection units throughout its summary', () => {
  const c = campaign();
  c.vector = 'http-slowloris';
  const html = renderCampaignReportHtml(c, run());
  expect(html).toContain('Under a bounded hold of up to');
  expect(html).toContain('Connections opened');
  expect(html).not.toContain('Under a bounded HTTP load configured');
  expect(html).not.toContain('Mean offered request rate');
  expect(html).toContain('HTTP request latency is not applicable');
  expect(html).toContain('Connections (opened / closed)');
  expect(html).toContain('Connection closure');
  expect(html).not.toContain('Requests (success / fail)');
  expect(html).not.toContain('HTTP failures (4xx/5xx)');
});
