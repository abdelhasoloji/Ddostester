import { renderDrsTimeline } from '../modules/metrics/drs-detail.js';
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { Store } from '../store/index.js';
import type { Permission } from '../auth/rbac.js';
import { verifyChain } from '../modules/audit/integrity.js';
import { buildWrsHistory } from '../modules/wrs/history.js';
import { deriveAlerts } from '../modules/alerts/derive.js';
import { deriveImpact } from '../modules/alerts/impact.js';
import { buildAbsorptionSummary } from '../modules/observability/summary.js';
import { buildZones } from '../modules/zones/zones.js';
import { validateMitigation } from '../modules/mitigation/validation.js';
import { queryRange, rangeWindow, type PromResult } from '../modules/metrics/prometheus-query.js';
import { resolveSeries } from '../modules/metrics/series-catalog.js';
import { renderFleetMetrics, renderMetrics } from '../modules/metrics/prometheus.js';
import { metrics } from '../modules/metrics/runtime.js';
import { renderComplianceHtml } from '../modules/reports/compliance.js';
import { renderBenchReportHtml } from '../modules/reports/bench-report.js';
import { BENCH_SCENARIOS } from '../modules/bench/model.js';
import { renderCompareHtml, compareRuns } from '../modules/reports/compare.js';
import { renderCampaignReportHtml } from '../modules/reports/report.js';
import { fleetEvidence } from '../modules/reports/fleet-evidence.js';
import { reconcileFleetReceipts } from '../modules/reports/fleet-receipts.js';
import { FLEET_LIMITS } from '../config/limits.js';
import { randomUUID } from 'node:crypto';
import { fleetStatusFromEnv } from '../modules/fleet/status.js';
import { persistedFleetEvidenceFromEnv } from '../modules/fleet/persisted-evidence.js';
import { htmlToPdf } from '../modules/reports/pdf.js';
import { runsSummaryCsv, runTimelineCsv } from '../modules/reports/csv.js';
import {
  buildSuites,
  renderSuiteReportHtml,
  renderSuiteCompareHtml,
} from '../modules/playbooks/suites.js';
import {
  analyzeGaps,
  inferProfile,
  buildNetworkLadder,
  renderGapAnalysisHtml,
  type ProtectionProfile,
} from '../modules/reports/gap-analysis.js';

/**
 * Sends a report as HTML, or as a paginated PDF when `?format=pdf` is requested
 * AND a headless browser is available (otherwise gracefully serves the HTML with
 * an `x-pdf-export: unavailable` header). See modules/reports/pdf.ts.
 */
async function sendReport(
  req: FastifyRequest,
  reply: FastifyReply,
  html: string,
  filename: string,
): Promise<unknown> {
  if ((req.query as { format?: string }).format === 'pdf') {
    const pdf = await htmlToPdf(html);
    if (pdf) {
      return reply
        .type('application/pdf')
        .header('content-disposition', `inline; filename="${filename}.pdf"`)
        .send(pdf);
    }
    reply.header('x-pdf-export', 'unavailable');
  }
  return reply.type('text/html').send(html);
}

/** Shared context the read-only routes need (no mutations, no run/audit writes). */
export interface ReadRoutesCtx {
  store: Store;
  guard: (perm: Permission) => preHandlerHookHandler;
  readTokenAllowed: (req: FastifyRequest) => boolean | Promise<boolean>;
  /**
   * Prometheus base URL for the app-native charts (option B). Absent → the
   * `/api/metrics/range` endpoint reports `unavailable` and the UI hides the
   * native charts. See modules/metrics/prometheus-query.ts.
   */
  prometheusUrl?: string;
  /** Grafana base URL — when set, HTML reports deep-link into the provisioned
   *  dashboards (scoped per run/target) instead of embedding a static SVG. */
  grafanaUrl?: string;
}

/**
 * Registers the read-only surface: suites, WRS history, Prometheus metrics, the
 * audit log + tamper-evidence, run listings, and the CSV/HTML report/exports.
 * Extracted from app.ts to keep the route table legible.
 */
export function registerReadRoutes(app: FastifyInstance, ctx: ReadRoutesCtx): void {
  const { store, guard, readTokenAllowed, prometheusUrl, grafanaUrl } = ctx;
  app.get('/api/bench/runs/:id/report', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const run = await store.getBenchRun((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return sendReport(req, reply, renderBenchReportHtml(run), 'bench-' + run.id.slice(0, 8));
  });
  app.get('/api/fleet/status', { preHandler: guard('campaign:read') }, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return fleetStatusFromEnv();
  });
  app.get<{ Params: { runId: string } }>(
    '/api/fleet/runs/:runId/evidence.json',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.runId))
        return reply.code(400).send({ error: 'Invalid fleet run identifier' });
      try {
        const evidence = await persistedFleetEvidenceFromEnv(req.params.runId);
        if (!evidence) return reply.code(404).send({ error: 'Fleet run not found' });
        reply.header(
          'content-disposition',
          `attachment; filename="fleet-${req.params.runId}-durable.json"`,
        );
        return evidence;
      } catch {
        return reply.code(503).send({ error: 'Durable fleet evidence unavailable' });
      }
    },
  );

  app.get<{ Params: { campaignId: string } }>(
    '/api/fleet/campaigns/:campaignId/evidence.json',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.campaignId))
        return reply.code(400).send({ error: 'Invalid campaign identifier' });
      try {
        const evidence = await persistedFleetEvidenceFromEnv(
          '',
          process.env,
          req.params.campaignId,
        );
        if (!evidence) return reply.code(404).send({ error: 'No recorded fleet evidence' });
        return evidence;
      } catch {
        return reply.code(503).send({ error: 'Durable fleet evidence unavailable' });
      }
    },
  );

  // App-native charts: bounded, read-only Prometheus range-query proxy.
  // The client asks for a NAMED series (never raw PromQL), scoped to an
  // optional target and time window; the app renders it with its own charts, so
  // the graph shows the same data as Grafana without embedding Grafana. Fail-
  // soft: no PROMETHEUS_URL → `source: "unavailable"` and the UI hides the chart.
  app.get('/api/metrics/range', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const { series, target, minutes, step, sinceSec } = req.query as {
      series?: string;
      target?: string;
      minutes?: string;
      step?: string;
      sinceSec?: string;
    };
    const resolved = series ? resolveSeries(series, target) : null;
    if (!resolved) {
      return reply
        .code(400)
        .send({ error: 'unknown series, or a per-run series is missing target' });
    }
    // `sinceSec` scopes the window to the live run's elapsed span so the chart
    // shows ONLY the current run (see rangeWindow); falls back to the `minutes`
    // lookback. Pure window math lives in prometheus-query for testability.
    const { startS, endS, stepS } = rangeWindow(Date.now(), { minutes, step, sinceSec });

    let source: PromResult['status'] = 'ok';
    const out: { label: string; points: [number, number][] }[] = [];
    for (const line of resolved.lines) {
      const r = await queryRange(prometheusUrl, line.promql, { startS, endS, stepS });
      if (r.status !== 'ok') source = r.status;
      // A well-formed named series maps to a single Prometheus series; if a query
      // fans out unexpectedly, take the first to keep the client contract simple.
      out.push({ label: line.label, points: r.series[0]?.points ?? [] });
    }
    return {
      name: series,
      unit: resolved.def.unit,
      title: resolved.def.title,
      source,
      series: out,
    };
  });

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
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const suite = await findSuite((req.params as { id: string }).id);
    if (!suite) return reply.code(404).send({ error: 'suite not found' });
    const runs = await store.listRuns();
    return sendReport(req, reply, renderSuiteReportHtml(suite, runs, { grafanaUrl }), 'assessment');
  });

  // Before / after comparison of two suites of the same playbook (the
  // "tune-and-replay" loop: replay the playbook after a WEDOS rule change and
  // read the per-line WRS/verdict delta). Read-only; generates no traffic.
  app.get('/api/reports/suite-compare', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
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

  // Evidence-seeded planning: infer the WEDOS control profile for a target from
  // recon posture, prior bounded runs' absorption, and the class-C LAB verdicts
  // (the L3/4 network evidence the L7 control plane can't observe), with the
  // provenance behind each. The operator reviews/overrides, then runs the plan.
  app.post(
    '/api/reports/gap-analysis/infer',
    { preHandler: guard('campaign:read') },
    async (req) => {
      const { target } = (req.body ?? {}) as { target?: string };
      const hostOf = (t?: string): string => {
        if (!t) return '';
        try {
          return new URL(t).host || t;
        } catch {
          return t.replace(/^https?:\/\//, '').split('/')[0];
        }
      };
      const wantHost = hostOf(target);
      const [campaigns, runs, labCoverage] = await Promise.all([
        store.listCampaigns(),
        store.listRuns(),
        store.listBenchCoverage(),
      ]);
      const hostOfCampaign = new Map(campaigns.map((c) => [c.id, hostOf(c.target)] as const));
      const matches = (h: string): boolean => !wantHost || h === wantHost;
      const posture = runs.find(
        (r) => r.posture && matches(hostOfCampaign.get(r.campaignId) ?? ''),
      )?.posture;
      const absorption = buildAbsorptionSummary(runs, campaigns).filter((row) =>
        matches(hostOf(row.target)),
      );
      return inferProfile({ posture, absorption, labCoverage });
    },
  );

  // The class-C LAB's L3/4 network DRS ladder — the network half of a full-stack
  // plan, overlaying the lab's per-scenario verdicts onto the DRS 3→5 tiers. Not
  // target-scoped: the bench evidence is about the network edge, not one host.
  app.get('/api/reports/network-ladder', { preHandler: guard('campaign:read') }, async () =>
    buildNetworkLadder(await store.listBenchCoverage()),
  );

  app.get('/api/wrs/history', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildWrsHistory(campaigns, runs);
  });

  // Read-only mitigation validation (TTD/TTM tier): correlates a run's measured
  // detection/mitigation timing with its load timeline (absorption + availability
  // before/after, WRS delta). Pure read — no traffic, no score change.
  app.get(
    '/api/runs/:runId/mitigation',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const run = await store.getRun((req.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      return validateMitigation({ timeline: run.timeline, protection: run.protection });
    },
  );

  app.get('/metrics/drs-timeline', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(renderDrsTimeline(await store.listCampaigns())),
  );

  app.get('/metrics', async (_req, reply) => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    // Business metrics (on-demand) + live runtime/operational metrics.
    const body =
      renderMetrics(campaigns, runs.length) + renderFleetMetrics(runs) + metrics.render();
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

  // Impact leaderboard (E16): the steps that actually floored the target, ranked
  // by how hard they hit — excluding probe-contention false negatives (PF1).
  app.get('/api/impact', { preHandler: guard('campaign:read') }, async (req) => {
    const { limit } = req.query as { limit?: string };
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return { impact: deriveImpact(runs, campaigns, { limit: limit ? Number(limit) : 20 }) };
  });

  // Analytics rollup (S1): per-(target, vector) absorption/WRS stats from the
  // durable run history — the query surface the `_last` gauges can't provide.
  app.get('/api/observability/summary', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildAbsorptionSummary(runs, campaigns);
  });

  // Protected ZONES — per-customer/host assurance posture, derived from the
  // existing campaign estate (see docs/vision-proving-ground.md). The unit WEDOS
  // Protection is sold and measured by.
  app.get('/api/zones', { preHandler: guard('campaign:read') }, async () => {
    const [campaigns, runs] = await Promise.all([store.listCampaigns(), store.listRuns()]);
    return buildZones(campaigns, runs);
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
  app.post<{ Params: { runId: string } }>(
    '/api/runs/:runId/fleet-receipts',
    {
      preHandler: guard('user:manage'),
      bodyLimit: FLEET_LIMITS.maxRps * FLEET_LIMITS.maxDurationSec * 512 + 4096,
    },
    async (req, reply) => {
      const run = await store.getRun(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'run_not_found' });
      if (!run.generator.fleet) return reply.code(409).send({ error: 'not_a_fleet_run' });
      if (run.generator.fleet.receiverEvidence)
        return reply.code(409).send({ error: 'receiver_evidence_already_recorded' });
      let evidence;
      try {
        evidence = reconcileFleetReceipts(run, req.body, req.authUser?.email ?? 'operator');
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : 'invalid_receiver_records' });
      }
      const recorded = await store.transaction(async (tx) => {
        const current = await tx.getRun(run.runId);
        if (!current?.generator.fleet || current.generator.fleet.receiverEvidence) return false;
        current.generator.fleet.receiverEvidence = evidence;
        await tx.saveRun(current);
        await tx.saveAudit({
          id: randomUUID(),
          at: evidence.recordedAt,
          actor: evidence.recordedBy,
          action: 'store.mutate',
          detail: `fleet.receiver.import run=${run.runId} sha256=${evidence.sha256} provenance=${evidence.provenance}`,
        });
        return true;
      });
      if (!recorded) return reply.code(409).send({ error: 'receiver_evidence_already_recorded' });
      return reply.code(201).send(evidence);
    },
  );

  app.get(
    '/api/runs/:runId/fleet-evidence.json',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const run = await store.getRun((req.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      if (!run.generator.fleet) return reply.code(409).send({ error: 'run has no fleet evidence' });
      reply.header('content-disposition', 'attachment; filename="fleet-evidence.json"');
      reply.header('cache-control', 'no-store');
      return fleetEvidence(run);
    },
  );

  // CSV exports (RPT-03) — browser downloads carry a read token in the query.
  app.get('/api/runs.csv', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const { campaignId } = req.query as { campaignId?: string };
    const runs = await store.listRuns(campaignId);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="shieldtest-runs.csv"')
      .send(runsSummaryCsv(runs));
  });

  app.get('/api/runs/:runId/timeline.csv', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const runId = (req.params as { runId: string }).runId;
    const r = await store.getRun(runId);
    if (!r) return reply.code(404).send({ error: 'run not found' });
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="shieldtest-run-${runId}.csv"`)
      .send(runTimelineCsv(r));
  });

  app.get('/api/reports/compliance', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const { from, to } = req.query as { from?: string; to?: string };
    const [campaigns, runs, coverage] = await Promise.all([
      store.listCampaigns(),
      store.listRuns(),
      store.listBenchCoverage(),
    ]);
    return sendReport(
      req,
      reply,
      renderComplianceHtml(campaigns, runs, {
        from,
        to,
        bench: { scenarios: BENCH_SCENARIOS, coverage },
      }),
      'compliance',
    );
  });

  app.get('/api/runs/:runId/report', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    const r = await store.getRun((req.params as { runId: string }).runId);
    if (!r) return reply.code(404).send({ error: 'run not found' });
    const c = await store.getCampaign(r.campaignId);
    if (!c) return reply.code(404).send({ error: 'campaign not found' });
    return sendReport(req, reply, renderCampaignReportHtml(c, r), 'report-' + r.runId.slice(0, 8));
  });

  // Before / after comparison of two runs (e.g. same target pre/post a
  // protection change). Read-only; generates no traffic.
  app.get('/api/reports/compare', async (req, reply) => {
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
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

  // Structured before/after comparison (Mitigation Proof): the WRS + per-metric
  // delta and a machine verdict, for the inline UI. Read-only; no traffic.
  app.get(
    '/api/reports/compare.json',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const { a, b } = req.query as { a?: string; b?: string };
      if (!a || !b) return reply.code(400).send({ error: 'both run ids (a, b) are required' });
      const [ra, rb] = await Promise.all([store.getRun(a), store.getRun(b)]);
      if (!ra || !rb) return reply.code(404).send({ error: 'run not found' });
      const [ca, cb] = await Promise.all([
        store.getCampaign(ra.campaignId),
        store.getCampaign(rb.campaignId),
      ]);
      if (!ca || !cb) return reply.code(404).send({ error: 'campaign not found' });
      return compareRuns({ campaign: ca, run: ra }, { campaign: cb, run: rb });
    },
  );
}
