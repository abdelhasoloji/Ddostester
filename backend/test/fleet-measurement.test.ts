import { expect, it } from 'vitest';
import { renderFleetMeasurementHtml } from '../src/modules/reports/fleet-measurement.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';
it('correlates the probe and agents without hiding cancelled requests or missing measurements', () => {
  const run = {
    campaignId: 'campaign',
    runId: 'run',
    generator: {
      startedAt: 'start',
      finishedAt: 'finish',
      config: { execution: { probeVantage: 'local' } },
      fleet: {
        measurementComplete: false,
        shards: [
          {
            agentId: '<script>bad</script>',
            state: 'STOPPED',
            result: {
              podIp: '10.1.1.1',
              generator: {
                totalRequests: 3,
                successful: 2,
                failed: 1,
                actualRps: 1,
                errors: { AbortError: 1 },
                latencyMs: { p95: 10 },
              },
            },
          },
          { agentId: 'lost', state: 'LOST' },
        ],
      },
    },
    probe: { available: 2, samples: 2, latencyMs: { p95: 20 } },
  } as unknown as CampaignRun;
  const html = renderFleetMeasurementHtml(run);
  expect(html).toContain('Campaign campaign · run run');
  expect(html).toContain('Probe vantage: local');
  expect(html).toContain('2/2 available observations');
  expect(html).toContain('Cancelled');
  expect(html).toContain('LOST');
  expect(html).toContain('unknown');
  expect(html).not.toContain('<script>bad');
  expect(html).toContain('&lt;script&gt;');
});
