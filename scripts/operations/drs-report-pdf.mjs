#!/usr/bin/env node
/**
 * Render a client-facing DRS report as a PDF from the JSON the API already produces.
 *
 *   node scripts/operations/drs-report-pdf.mjs report.json drs-report.pdf
 *
 * The JSON comes from GET /api/campaigns/:id/drs/report.json. The PDF is the deliverable a
 * client keeps: verdict, the archived requirements the fleet did not reach, the reservations
 * and the evidence hashes. It is deliberately plain — no decoration, no marketing.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: drs-report-pdf.mjs <report.json> <out.pdf>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(input, 'utf8'));
const a = report.assessment ?? {};
const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const levels = (a.levels ?? [])
  .map(
    (l) =>
      `<tr><td>${l.level}</td><td>${l.total}</td><td>${l.passed}</td><td>${l.failed}</td><td>${l.inconclusive}</td><td>${l.excluded}</td><td>${esc(l.outcome)}</td></tr>`,
  )
  .join('');

const gaps = (a.requirementGaps ?? [])
  .map(
    (g) =>
      `<tr class="${g.met ? '' : 'unmet'}"><td>${esc(g.vectorId)}</td><td>${g.level}</td><td>${esc(g.dimension)}</td><td>${esc(g.required)}</td><td>${esc(g.achieved)}</td><td>${g.met ? 'yes' : 'no'}</td></tr>`,
  )
  .join('');

const reservations = (a.reservations ?? []).map((r) => `<li>${esc(r)}</li>`).join('');
const proofs = (report.proofs ?? [])
  .map(
    (p) =>
      `<tr><td>${esc(p.id)}</td><td>${esc(p.provenance)}</td><td class="mono">${esc(p.hash)}</td></tr>`,
  )
  .join('');
const scope = report.scope ?? [];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #16202f; }
  h1 { font-size: 20pt; margin: 0 0 2mm; color: #0a356b; }
  h2 { font-size: 12pt; margin: 8mm 0 2mm; color: #0a356b; border-bottom: 1px solid #d6deea; padding-bottom: 1mm; }
  .sub { color: #5b6b82; margin: 0 0 6mm; }
  .verdict { border: 1px solid #d6deea; border-left: 4px solid ${a.status === 'COMPLETE' ? '#2e7d32' : '#b26a00'}; padding: 3mm 4mm; margin: 4mm 0 6mm; }
  .verdict b { font-size: 13pt; }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; }
  th, td { border: 1px solid #d6deea; padding: 1.6mm 2mm; text-align: left; font-size: 9.5pt; }
  th { background: #f2f5fa; }
  tr.unmet td { background: #fdf3e3; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 7.5pt; word-break: break-all; }
  .foot { margin-top: 8mm; color: #5b6b82; font-size: 8.5pt; }
  ul { margin: 1mm 0 4mm 4mm; padding: 0; }
</style></head><body>
  <h1>DDoS Resiliency Score — assessment report</h1>
  <p class="sub">Standard ${esc(report.reference?.standardVersion)} · engine ${esc(report.reference?.engineVersion)} · interpretation ${esc(report.reference?.interpretationProfile)} · revision ${esc(report.revision)}</p>

  <div class="verdict">
    <b>${esc(a.status)} · terminal level ${esc(a.terminalLevel ?? '—')} · ${esc(a.terminalOutcome)}</b><br>
    ${a.score === null || a.score === undefined ? 'No usable score.' : `Score ${esc(a.score)}.`}
    ${a.certification === false ? ' Not a certification.' : ''}
  </div>

  <h2>Scope</h2>
  <table><tr><th>Service</th><th>URL</th><th>Journey</th><th>Assertion</th></tr>
  ${scope.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.url)}</td><td>${esc(s.journey)}</td><td>${esc(s.functionalAssertion)}</td></tr>`).join('')}
  </table>

  <h2>Levels</h2>
  <table><tr><th>Level</th><th>Vectors</th><th>Passed</th><th>Failed</th><th>Inconclusive</th><th>Excluded</th><th>Outcome</th></tr>${levels}</table>

  <h2>Archived requirements versus recorded evidence</h2>
  ${gaps ? `<table><tr><th>Vector</th><th>Level</th><th>Dimension</th><th>Required</th><th>Recorded</th><th>Met</th></tr>${gaps}</table>` : '<p>No archived requirement applies to the evaluated vectors.</p>'}

  <h2>Reservations</h2>
  <ul>${reservations}</ul>

  <h2>Evidence</h2>
  ${proofs ? `<table><tr><th>Proof</th><th>Provenance</th><th>SHA-256</th></tr>${proofs}</table>` : '<p>No sealed proof in this revision.</p>'}

  <p class="foot">Generated from the frozen plan and the sealed evidence chain. Catalogue ${esc(report.reference?.catalogueHash)}.</p>
</body></html>`;

// Prefer the workstation's Chrome: the bundled browser version pins to the Playwright
// release, and an update can leave it missing. Chrome is present and is what the operator
// prints from anyway.
const browser = await chromium.launch({ channel: 'chrome' }).catch(() =>
  chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }),
);
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: output, format: 'A4', printBackground: true });
await browser.close();
console.log(`OK ${output}`);
