import type { BenchRun } from '../bench/model.js';
import { htmlEscape as esc } from '../../util/text.js';
import { docHead, coverBand, DOC_TAIL, statCard } from './layout.js';

/** Experimental bench observations retain their units; no inferred DRS score. */
export function renderBenchReportHtml(run: BenchRun): string {
  const v = run.verdict;
  const number = (value: number | undefined, unit = '') =>
    value !== undefined && Number.isFinite(value)
      ? `${value.toLocaleString('en-US')}${unit}`
      : 'unknown';
  const rows: [string, string][] = [
    ['Run', run.id],
    ['Scenario', run.scenario],
    ['Status', run.status],
    ['Outcome', v?.outcome ?? 'not evaluated'],
    ['Lab scope', run.labTarget],
    ['Runner', run.claimedBy ?? 'unknown'],
    ['Requested', run.requestedAt],
    ['Completed', run.completedAt ?? 'not completed'],
    ['Generator requests', number(v?.requests)],
    ['Received packets', number(v?.target?.packets)],
    ['Received packet rate', number(v?.target?.avgPps, ' packets/s')],
    ['Received bit rate', number(v?.target?.avgBps, ' bits/s')],
    ['Byte amplification ratio', number(v?.amplificationFactor, '×')],
    ['Packet amplification ratio', number(v?.packetAmplification, '×')],
    ['Error', run.error ?? 'none reported'],
  ];
  return (
    docHead('Synthetic network campaign report') +
    coverBand('Synthetic network campaign', esc(run.scenario)) +
    `<p class="lead">Bounded synthetic laboratory observations. These are not HTTP requests/s, a measured DRS score, or a certification. Amplification ratios do not multiply the received bit rate.</p>` +
    `<div class="stats">${statCard('STATUS', esc(run.status))}${statCard('RECEIVED PACKETS', number(v?.target?.packets))}${statCard('RECEIVED BITS/S', number(v?.target?.avgBps))}</div>` +
    `<h2>Retained observations</h2><table>${rows.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value)}</td></tr>`).join('')}</table>` +
    `<p>Unknown counters remain unknown. A completed baseline without a scrubber does not demonstrate mitigation. This artifact does not establish independent Internet sources, an external reflection chain, or protection-entry/origin/user evidence.</p>` +
    DOC_TAIL
  );
}
