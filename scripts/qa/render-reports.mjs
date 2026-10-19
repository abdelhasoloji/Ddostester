import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { renderCampaignReportHtml } from '../../backend/dist/modules/reports/report.js';
import { renderComplianceHtml } from '../../backend/dist/modules/reports/compliance.js';
import { renderCompareHtml } from '../../backend/dist/modules/reports/compare.js';
import {
  buildSuites,
  renderSuiteReportHtml,
  renderSuiteCompareHtml,
} from '../../backend/dist/modules/playbooks/suites.js';
const source = new URL('../../docs/qa/graph-consistency-2026-10-17/', import.meta.url).pathname;
const runs = JSON.parse(gunzipSync(await readFile(source + 'runs.json.gz')).toString());
const campaigns = JSON.parse(gunzipSync(await readFile(source + 'campaigns.json.gz')).toString());
const { analyzeGaps, renderGapAnalysisHtml } =
  await import('../../backend/dist/modules/reports/gap-analysis.js');
const { runsSummaryCsv } = await import('../../backend/dist/modules/reports/csv.js');
const before = JSON.stringify({ runs, campaigns });
const dir = process.argv[2] ?? '/tmp/reports-critical-preview';
await mkdir(dir, { recursive: true });
const campById = new Map(campaigns.map((c) => [c.id, c]));
for (const r of runs)
  await writeFile(
    dir + '/' + r.runId + '.html',
    renderCampaignReportHtml(campById.get(r.campaignId), r),
  );
await writeFile(dir + '/runs.csv', runsSummaryCsv(runs));
const [suite] = buildSuites(campaigns);
await writeFile(dir + '/suite.html', renderSuiteReportHtml(suite, runs));
await writeFile(dir + '/portfolio.html', renderComplianceHtml(campaigns, runs));
await writeFile(
  dir + '/compare.html',
  renderCompareHtml(
    { campaign: campById.get(runs[0].campaignId), run: runs[0] },
    { campaign: campById.get(runs[1].campaignId), run: runs[1] },
  ),
);
await writeFile(dir + '/suite-compare.html', renderSuiteCompareHtml(suite, suite));
await writeFile(
  dir + '/gap-plan.html',
  renderGapAnalysisHtml(analyzeGaps({}, 'http://10.98.215.52:8080/')),
);
const slow = runs.find((r) => r.generator.config.slowloris);
await writeFile(
  dir + '/index.html',
  '<html><body><h1>Report critical review</h1>' +
    ['suite', 'portfolio', 'compare', 'suite-compare', slow.runId]
      .map((p) => `<p><a href="${p}.html">${p}</a></p>`)
      .join('') +
    '</body></html>',
);
if (before !== JSON.stringify({ runs, campaigns }))
  throw Error('Report renderer mutated archived evidence');
const proof = {
  runsRendered: runs.length,
  additionalReports: 5,
  trafficGenerated: false,
  archivedInputsUnchanged: true,
  archivedJsonSha256: createHash('sha256').update(before).digest('hex'),
  slowRunId: slow.runId,
};
await writeFile(dir + '/render-check.json', JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
