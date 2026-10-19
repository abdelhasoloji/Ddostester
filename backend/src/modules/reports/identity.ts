import type { CampaignRun } from '../campaigns/runner.js';
import { getBuildInfo } from '../../version.js';
import { htmlEscape as esc } from '../../util/text.js';

/** Renderer identity is distinct from the source that originally collected a run. */
export function reportIdentityHtml(run: CampaignRun, compact = false): string {
  const renderer = getBuildInfo();
  const execution = run.generator.config?.execution;
  const rows = [
    ['Run ID', run.runId],
    ['Campaign ID', run.campaignId],
    [
      'Generator window (recorded)',
      `${run.generator.startedAt ?? 'not recorded'} → ${run.generator.finishedAt ?? 'not recorded'}`,
    ],
    [
      'Recorded engine / runtime',
      `${execution?.engine ?? 'not recorded'} / ${execution?.runtime ?? 'not recorded'}`,
    ],
    ['Recorded collection source', execution?.sourceRef ?? 'not recorded'],
    ['Probe vantage (recorded)', execution?.probeVantage ?? 'not recorded'],
    ['Report renderer', `${renderer.version}+${renderer.build} · ${renderer.commit}`],
  ];
  if (compact)
    return `<p class="muted" style="font-size:.78rem"><b>Recorded evidence:</b> ${rows.map(([key, value]) => `${esc(key)}: ${esc(String(value ?? 'not recorded'))}`).join(' · ')}</p>`;
  return `<h3>Evidence traceability</h3><table class="kvs">${rows.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(String(value ?? 'not recorded'))}</td></tr>`).join('')}</table><p class="muted">Recorded identifiers are not independent provenance verification. Regenerating a report changes its presentation, not the archived measurements or collection version.</p>`;
}
