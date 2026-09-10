import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Store } from '../store/index.js';
import type { Permission } from '../auth/rbac.js';
import { verifyChain } from '../modules/audit/integrity.js';
import { buildWrsHistory } from '../modules/wrs/history.js';
import { deriveAlerts } from '../modules/alerts/derive.js';
import { buildAbsorptionSummary } from '../modules/observability/summary.js';
import { renderMetrics } from '../modules/metrics/prometheus.js';
import { metrics } from '../modules/metrics/runtime.js';
import { renderComplianceHtml } from '../modules/reports/compliance.js';
import { BENCH_SCENARIOS } from '../modules/bench/model.js';
import { renderCompareHtml } from '../modules/reports/compare.js';
import { renderCampaignReportHtml } from '../modules/reports/report.js';
import { runsSummaryCsv, runTimelineCsv } from '../modules/reports/csv.js';
import {
  buildSuites,
  renderSuiteReportHtml,
  renderSuiteCompareHtml,
} from '../modules/playbooks/suites.js';
import {
  analyzeGaps,
  renderGapAnalysisHtml,
  type ProtectionProfile,
} from '../modules/reports/gap-analysis.js';

/** Shared context the read-only routes need (no mutations, no run/audit writes). */
export interface ReadRoutesCtx {
  store: Store;
  guard: (perm: Permission) => preHandlerHookHandler;
  readTokenAllowed: (req: FastifyRequest) => boolean;
}

/**
 * Registers the read-only surface: suites, WRS history, Prometheus metrics, the
 * audit log + tamper-evidence, run listings, and the CSV/HTML report/exports.
 * Extracted from app.ts to keep the route table legible.
 */
export function registerReadRoutes(app: FastifyInstance, ctx: ReadRoutesCtx): void {
  const { store, guard, readTokenAllowed } = ctx;

  // Consolidated assessment suites (campaigns grouped by playbook run).
  app.get('/api/suites', { preHandler: guard('campaign:read') }, async () =>
    buildSuites(await store.listCampaigns()),
  );

  const findSuite = async (id: string) =>
    buildSuites(await store.listCampaigns()).find((s) => s.suiteId === id);

  app.get('/api/suites/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const suite = await findSuite((req.params as { id: string }).id);
    return suite ?? reply.code(404).send({ error: 'suite not found' });
  });

  app.get('/api/suites/:id/report', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const suite = await findSuite((req.params as { id: string }).id);
    if (!suite) return reply.code(404).send({ error: 'suite not found' });
    const runs = await store.listRuns();
    return reply.type('text/html').send(renderSuiteReportHtml(suite, runs));
  });

  // Before / after comparison of two suites of the same playbook (the
  // "tune-and-replay" loop: replay the playbook after a WEDOS rule change and
  // read the per-line WRS/verdict delta). Read-only; generates no traffic.
  app.get('/api/reports/suite-compare', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const { a, b } = req.query as { a?: string; b?: string };
    if (!a || !b) return reply.code(400).send({ error: 'both suite ids (a, b) are required' });
    const [sa, sb] = await Promise.all([findSuite(a), findSuite(b)]);
    if (!sa || !sb) return reply.code(404).send({ error: 'suite not found' });
    return reply.type('text/html').send(renderSuiteCompareHtml(sa, sb));
  });

  // Protection-gap analyzer: map the declared WEDOS controls to a prioritised
  // plan of bounded playbook lines to replay (tune-and-replay front half), plus
  // the attestation-only lines. Analytical only — reads a declared profile,
  // generates no traffic, synthesises no vectors. `?format=html` for print/PDF.
  app.post(
    '/api/reports/gap-analysis',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const body = (req.body ?? {}) as { profile?: ProtectionProfile; target?: string };
      const analysis = analyzeGaps(body.profile ?? {}, body.target);
      if ((req.query as { format?: string }).format === 'html') {
        return reply.type('text/html').send(renderGapAnalysisHtml(analysis));
      }
      return analysis;
    },
  );

  app.get('/api/wrs/history', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildWrsHistory(campaigns, runs);
  });

  app.get('/metrics', async (_req, reply) => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    // Business metrics (on-demand) + live runtime/operational metrics.
    const body = renderMetrics(campaigns, runs.length) + metrics.render();
    return reply.type('text/plain; version=0.0.4').send(body);
  });

  app.get('/api/audit', { preHandler: guard('campaign:read') }, async (req) => {
    const { limit } = req.query as { limit?: string };
    return store.listAudit(limit ? Number(limit) : 200);
  });

  // In-app alerts derived from the platform's own run history (self-contained;
  // no dependency on the Prometheus/Alertmanager reachability). Powers the
  // header alerts banner so the app is a single pane of glass.
  app.get('/api/alerts', { preHandler: guard('campaign:read') }, async (req) => {
    const { limit } = req.query as { limit?: string };
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return deriveAlerts(runs, campaigns, { limit: limit ? Number(limit) : 50 });
  });

  // Analytics rollup (S1): per-(target, vector) absorption/WRS stats from the
  // durable run history — the query surface the `_last` gauges can't provide.
  app.get('/api/observability/summary', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildAbsorptionSummary(runs, campaigns);
  });

  // EPIC D: verify the tamper-evident audit chain end to end.
  app.get('/api/audit/verify', { preHandler: guard('campaign:read') }, async () => {
    return verifyChain(await store.listAuditChain());
  });

  // EPIC D: downloadable, self-verifiable audit export (entries + hashes + verdict).
  app.get('/api/audit/export', { preHandler: guard('campaign:read') }, async (_req, reply) => {
    const entries = await store.listAuditChain();
    const verdict = verifyChain(entries);
    const doc = {
      kind: 'wedos-shieldtest-audit-export',
      generatedAt: new Date().toISOString(),
      count: entries.length,
      headHash: verdict.headHash,
      verdict,
      entries,
    };
    reply.header('content-disposition', 'attachment; filename="shieldtest-audit-export.json"');
    return reply.type('application/json').send(JSON.stringify(doc, null, 2));
  });

  app.get('/api/runs', { preHandler: guard('campaign:read') }, async (req) => {
    const { campaignId } = req.query as { campaignId?: string };
    return store.listRuns(campaignId);
  });

  app.get('/api/runs/:runId', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const r = await store.getRun((req.params as { runId: string }).runId);
    return r ?? reply.code(404).send({ error: 'run not found' });
  });

  // CSV exports (RPT-03) — browser downloads carry a read token in the query.
  app.get('/api/runs.csv', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const { campaignId } = req.query as { campaignId?: string };
    const runs = await store.listRuns(campaignId);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="shieldtest-runs.csv"')
      .send(runsSummaryCsv(runs));
  });

  app.get('/api/runs/:runId/timeline.csv', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const runId = (req.params as { runId: string }).runId;
    const r = await store.getRun(runId);
    if (!r) return reply.code(404).send({ error: 'run not found' });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="shieldtest-run-${runId}.csv"`)
      .send(runTimelineCsv(r));
  });

  app.get('/api/reports/compliance', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const { from, to } = req.query as { from?: string; to?: string };
    const [campaigns, runs, coverage] = await Promise.all([
      store.listCampaigns(),
      store.listRuns(),
      store.listBenchCoverage(),
    ]);
    return reply.type('text/html').send(
      renderComplianceHtml(campaigns, runs, {
        from,
        to,
        bench: { scenarios: BENCH_SCENARIOS, coverage },
      }),
    );
  });

  app.get('/api/runs/:runId/report', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const r = await store.getRun((req.params as { runId: string }).runId);
    if (!r) return reply.code(404).send({ error: 'run not found' });
    const c = await store.getCampaign(r.campaignId);
    if (!c) return reply.code(404).send({ error: 'campaign not found' });
    return reply.type('text/html').send(renderCampaignReportHtml(c, r));
  });

  // Before / after comparison of two runs (e.g. same target pre/post a
  // protection change). Read-only; generates no traffic.
  app.get('/api/reports/compare', async (req, reply) => {
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    const { a, b } = req.query as { a?: string; b?: string };
    if (!a || !b) return reply.code(400).send({ error: 'both run ids (a, b) are required' });
    const [ra, rb] = await Promise.all([store.getRun(a), store.getRun(b)]);
    if (!ra || !rb) return reply.code(404).send({ error: 'run not found' });
    const [ca, cb] = await Promise.all([
      store.getCampaign(ra.campaignId),
      store.getCampaign(rb.campaignId),
    ]);
    if (!ca || !cb) return reply.code(404).send({ error: 'campaign not found' });
    return reply
      .type('text/html')
      .send(renderCompareHtml({ campaign: ca, run: ra }, { campaign: cb, run: rb }));
  });
}
