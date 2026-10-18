// Read-only presentation replay. Never submits, approves or executes campaigns.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderCampaignReportHtml } from '../../../backend/dist/modules/reports/report.js';
import {
  buildSuites,
  renderSuiteReportHtml,
} from '../../../backend/dist/modules/playbooks/suites.js';
const dir = dirname(fileURLToPath(import.meta.url));
const source = join(dir, '../zerobs-full-2026-10-17');
const campaignBytes = await readFile(join(source, 'campaigns.json'));
const runBytes = await readFile(join(source, 'runs.json'));
const campaigns = JSON.parse(campaignBytes),
  runs = JSON.parse(runBytes);
const rows = [];
for (const campaign of campaigns) {
  const run = runs.find((r) => r.campaignId === campaign.id);
  if (run) {
    const report = renderCampaignReportHtml(campaign, run);
    if (/\bNaN\b|>undefined</.test(report)) throw Error('Invalid report measurement serialization');
  }
  rows.push({
    name: campaign.name,
    recordedStatus: campaign.status,
    hasRetainedRun: !!run,
    probeObservations: run?.probe.samples ?? null,
    availability: run?.probe.samples ? (100 * run.probe.available) / run.probe.samples : null,
  });
}
const suites = buildSuites(campaigns);
if (suites.length !== 1 || rows.length !== 12)
  throw Error('Expected the archived twelve-step suite');
const html = renderSuiteReportHtml(suites[0], runs);
if (html.includes('No run data; legitimate availability dipped to 0%'))
  throw Error('Missing evidence was represented as measured outage');
if (/\bNaN\b|>undefined</.test(html)) throw Error('Invalid consolidated report');
await writeFile(join(dir, 'historical-suite.html'), html);
await writeFile(
  join(dir, 'historical-replay.json'),
  JSON.stringify(
    {
      mode: 'retained-evidence-replay',
      newCampaignsExecuted: 0,
      externalTrafficGenerated: false,
      sourceHashes: {
        campaigns: createHash('sha256').update(campaignBytes).digest('hex'),
        runs: createHash('sha256').update(runBytes).digest('hex'),
      },
      rows,
    },
    null,
    2,
  ) + '\n',
);
console.log('Twelve historical steps replayed; no traffic generated.');
