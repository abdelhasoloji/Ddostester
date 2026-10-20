#!/usr/bin/env node
/**
 * DRS end-to-end proof, without the control plane.
 *
 * It builds a frozen measured plan, drives the orchestrator with the real generator and
 * probe collector against a loopback target, and asserts that a sealed proof and a final
 * report come out. That is the one thing unit tests cannot show: the loop actually runs.
 *
 *   DRS_BASELINE_FLOOR_SEC=2 node --experimental-strip-types scripts/qa/drs-e2e.mjs
 *
 * CI runs it as part of the DRS job; it takes about fifteen seconds.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const src = (p) => pathToFileURL(new URL(`../../backend/src/${p}`, import.meta.url).pathname).href;
const { defaultPlan, createRevision, currentRevision, freeze } = await import(
  src('modules/drs/workflow.ts')
);
const { orchestrateDrs } = await import(src('modules/drs/orchestrator.ts'));
const { createEngineGeneratorPort } = await import(src('modules/drs/engine-generator.ts'));
const { createProbeCollectorPort } = await import(src('modules/drs/probe-collector.ts'));

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const campaign = {
  id: 'e2e',
  name: 'DRS e2e',
  status: 'PENDING_APPROVAL',
  createdBy: 'ci',
  createdAt: new Date().toISOString(),
  target: url,
  probeUrl: url,
  authorized: true,
  agent: 'builtin',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 2,
  maxDurationSec: 10,
};

const plan = defaultPlan(campaign, 'measured');
plan.maxLevel = 1;
plan.exposureSec = 10;
plan.baselineMinSec = 5;
plan.excludedVectors = [
  {
    vectorId: 'drs-3.00.00-111001',
    reason: 'not dispatchable by this control plane; reference/import evidence only',
  },
];
const doc = createRevision(undefined, plan, 'ci');
const revision = currentRevision(doc);
freeze(revision, campaign);

const generator = createEngineGeneratorPort({ url, allowedHosts: ['127.0.0.1'] });
const collector = createProbeCollectorPort({ probeUrl: url, baselineMaxSec: 5 });
const assessment = await orchestrateDrs(revision, 'ci', {
  generator,
  collector,
  signal: new AbortController().signal,
  checkpoint: async () => {},
});
await new Promise((resolve) => server.close(resolve));

const checks = [
  [revision.state === 'FINAL_REPORT', `revision state ${revision.state}`],
  [revision.proofs.length >= 1, `sealed proofs: ${revision.proofs.length}`],
  [assessment.status === 'PARTIAL', `assessment status ${assessment.status}`],
  [assessment.certification === false, 'assessment must not be a certification'],
];
const points = revision.proofs[0]?.data.points.map((p) => p.sourceId) ?? [];
for (const id of ['generator', 'user'])
  checks.push([points.includes(id), `evidence missing ${id} point`]);

const failed = checks.filter(([ok]) => !ok).map(([, why]) => why);
if (failed.length) fail(failed.join('; '));

console.log(
  `OK  state=${revision.state} proofs=${revision.proofs.length} status=${assessment.status} ` +
    `points=${points.join(',')} transactions=${revision.proofs[0].data.legitimate_transaction_success[0].successful}/${revision.proofs[0].data.legitimate_transaction_success[0].total}`,
);
