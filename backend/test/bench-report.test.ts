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
