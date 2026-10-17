import { expect, it } from 'vitest';
import { renderBenchReportHtml } from '../src/modules/reports/bench-report.js';

it('retains unknown receiver counters and escapes stored labels without inventing a score', () => {
  const html = renderBenchReportHtml({
    id: 'one',
    scenario: '<script>bad</script>',
    labTarget: 'lab',
    status: 'FAILED',
    requestedBy: 'operator',
    requestedAt: '2026-10-17',
    error: 'collector unavailable',
  });
  expect(html).toContain('unknown');
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  expect(html).not.toContain('<script>bad</script>');
  expect(html).toContain('collector unavailable');
  expect(html).toContain('not HTTP requests/s');
});

it('renders TCP connection evidence with zero values and no invented UDP counters', () => {
  const html = renderBenchReportHtml({
    id: 'tcp',
    scenario: 'tcp_synflood',
    labTarget: 'loopback',
    status: 'COMPLETED',
    requestedBy: 'operator',
    requestedAt: '2026-10-17',
    verdict: {
      schema: 'shieldtest.lab.verdict/v1',
      class: 'C',
      kind: 'tcp-connection-pressure',
      outcome: 'STATE_TABLE_SATURATED',
      connections: {
        opened: 870,
        accepted: 200,
        refused: 670,
        concurrentPeak: 200,
        capacity: 200,
        saturationPct: 77.01,
      },
    },
  });
  for (const label of [
    'Connections opened',
    'Connections accepted',
    'Connections refused',
    'Concurrent peak',
    'Connection capacity',
    '77.01%',
  ])
    expect(html).toContain(label);
  expect(html).toContain('870');
  expect(html).not.toContain('Received packets');
  expect(html).not.toContain('Byte amplification ratio');
});
