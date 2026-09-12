import { existsSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Store } from './store/index.js';
import type { AuthState } from './auth/guard.js';
import { kills } from './runtime/kills.js';
import { liveProgress } from './runtime/live.js';
import { metrics } from './modules/metrics/runtime.js';
import { computeAbsorption } from './modules/reports/absorption.js';
import { computeConfidence, EVENT_LOOP_LAG_GUARD_MS } from './modules/reports/confidence.js';
import {
  createCampaign,
  approveCampaign,
  cisoApproveCampaign,
  assertExecutable,
  cancelCampaign,
  setArchived,
  transition,
  CampaignError,
} from './modules/campaigns/service.js';
import { executeCampaign } from './modules/campaigns/runner.js';
import { waitForTargetAvailable, type RecoveryOptions } from './modules/campaigns/recovery.js';
import { reArmRecurring } from './modules/campaigns/scheduler.js';
import type { CampaignRun } from './modules/campaigns/runner.js';
import type { Campaign, CampaignInput, CampaignStatus } from './modules/campaigns/model.js';
import {
  HARD_CAPS,
  MAX_COMPOSITE_STEPS,
  BUILTIN_RPS_CEILING,
  clampToCeiling,
  withinCeiling,
} from './config/limits.js';
import { highRateEngineUpgrade } from './modules/campaigns/engine-route.js';
import type { HardCaps } from './config/limits.js';
import {
  BENCH_SCENARIOS,
  isKnownBenchScenario,
  parseBenchVerdict,
  parseCoverageInput,
  parseAttestationInput,
  parseIngestBatch,
  ATTESTATION_CHECKLISTS,
} from './modules/bench/model.js';
import type { BenchRun, BenchCoverage } from './modules/bench/model.js';
import { KillSwitch } from './modules/probe/probe.js';
import { registerReadRoutes } from './routes/read-routes.js';
import { buildWrsHistory } from './modules/wrs/history.js';
import type { AuditEntry } from './modules/audit/model.js';
import type { LoadProgress } from './engine/loadTest.js';
import { login, identityFromRequest, payloadFromRequest } from './auth/guard.js';
import { signJwt } from './auth/jwt.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import { passwordProblem } from './auth/password-policy.js';
import { can } from './auth/rbac.js';
import type { Permission, Role } from './auth/rbac.js';
import type { User } from './auth/users.js';
import {
  assertDelete,
  assertReset,
  assertRoleChange,
  assertStatusChange,
  assertUpsert,
  combineUsers,
  UserError,
} from './modules/users/service.js';
import { BuiltinHttpAgent } from './agents/builtin.js';
import { createAgent, describeAgents, agentChoices } from './agents/index.js';
import { runRecon } from './modules/recon/fetch.js';
import { AgentError, type AttackAgent } from './agents/types.js';
import { buildRunNotifications } from './modules/notify/events.js';
import { noopNotifier } from './modules/notify/notifier.js';
import type { Notifier } from './modules/notify/types.js';
import { noopProtectionProvider } from './modules/protection/provider.js';
import type { ProtectionProvider } from './modules/protection/types.js';
import {
  createEdgeAbsorptionProvider,
  edgeAbsorptionConfigFromEnv,
} from './modules/edge-absorption/provider.js';
import type { EdgeAbsorptionProvider } from './modules/edge-absorption/types.js';
import { corroborate } from './modules/edge-absorption/corroboration.js';
import { noopTargetTelemetryProvider } from './modules/target-telemetry/provider.js';
import type { TargetTelemetryProvider } from './modules/target-telemetry/types.js';
import {
  PLAYBOOKS,
  getPlaybook,
  buildSuiteCampaigns,
  buildCompositeSuite,
  validatePlaybookInput,
  PlaybookError,
} from './modules/playbooks/playbooks.js';
import type { Playbook } from './modules/playbooks/playbooks.js';
import { tlsInsecure } from './util/tls.js';
import { getBuildInfo } from './version.js';

export interface BuildOptions {
  store: Store;
  auth: AuthState;
  allowedTargets: string[];
  /**
   * Isolated lab targets for DRS-validation records (policy: drs-validation-policy.md).
   * Fail-closed: must NOT overlap allowedTargets. Empty = validation disabled.
   */
  labTargets?: string[];
  logger?: boolean;
  serveStatic?: boolean;
  /** Load agent (default: built-in bounded HTTP generator). */
  agent?: AttackAgent;
  /**
   * Auto-route a high-rate simple flood off the built-in engine (which caps
   * ~150 rps) onto an available out-of-process engine so it delivers the
   * configured rate. Default true; set false to pin every run to its chosen
   * engine (e.g. for deterministic tests).
   */
  autoRouteHighRps?: boolean;
  /** Notification sink (default: no-op — notifications are opt-in). */
  notifier?: Notifier;
  /** Protection integration for real detection/mitigation (default: no-op). */
  protection?: ProtectionProvider;
  edgeAbsorption?: EdgeAbsorptionProvider;
  /** Target host-telemetry source correlated to the run (default: no-op). */
  targetTelemetry?: TargetTelemetryProvider;
  /** Max campaigns running at once (safety guard against contention). Default 3. */
  maxConcurrentRuns?: number;
  /**
   * Dual control: when true, a campaign needs a CISO sign-off (on top of the
   * officer approval) before it can run — the governance posture for a
   * networked/public deployment. Default false (single-officer approval).
   */
  requireCisoApproval?: boolean;
  /**
   * Bearer token an isolated bench runner presents to claim/complete governed
   * class-C runs. Empty/undefined = governed dispatch disabled (fail-closed):
   * requests can't be created and the runner API is closed. The control plane
   * never executes the run — only records it and serves it to the runner.
   */
  benchRunnerToken?: string;
  /**
   * Prometheus base URL for the app-native charts (`/api/metrics/range`). Absent
   * = the native charts report `unavailable` and the UI hides them. Prometheus is
   * loopback on the monitoring host, so in production this points at a tunnel.
   */
  prometheusUrl?: string;
  /**
   * Between-wave availability gate for suite sequences: after one step's load
   * settles, hold the next step until the target is reachable again (bounded).
   * Defaults to production values; pass a partial to tune, or `false` to disable
   * (tests that target an intentionally-down host set this so they don't wait).
   */
  suiteRecovery?: Partial<RecoveryOptions> | false;
}

export interface BuiltApp {
  app: FastifyInstance;
  runCampaign: (c: Campaign, actor: string) => Promise<CampaignRun>;
}

/** Builds the Fastify app (routes + logic) without starting to listen. */
export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { store, auth, allowedTargets } = opts;
  const labTargets = opts.labTargets ?? [];
  // Fail-closed separation (drs-validation-policy.md §4): a lab target must never
  // also be a production allowlist target, and vice-versa.
  const overlap = labTargets.filter((t) => allowedTargets.includes(t));
  if (overlap.length > 0) {
    throw new Error(
      `LAB_TARGETS must not overlap ALLOWED_TARGETS (offending: ${overlap.join(', ')}).`,
    );
  }
  // Effective operational caps = the CISO-set limits when present, otherwise the
  // immutable HARD_CAPS ceiling. Always clamped ≤ ceiling (defense in depth: even
  // a tampered stored value can never widen the envelope). Held in memory and
  // refreshed by PUT /api/limits; enforcement reads this, never a raw stored value.
  let effectiveCaps: HardCaps = clampToCeiling(await store.getLimits());
  const agent = opts.agent ?? new BuiltinHttpAgent();
  const notifier = opts.notifier ?? noopNotifier;
  const protection = opts.protection ?? noopProtectionProvider;
  const edgeAbsorption =
    opts.edgeAbsorption ?? createEdgeAbsorptionProvider(edgeAbsorptionConfigFromEnv());
  const targetTelemetry = opts.targetTelemetry ?? noopTargetTelemetryProvider;
  const maxConcurrentRuns = opts.maxConcurrentRuns ?? 3;
  const requireCisoApproval = opts.requireCisoApproval ?? false;

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            // Never log tokens passed in the query (?token=) or the Authorization header.
            serializers: {
              req(req) {
                return {
                  method: req.method,
                  url: String(req.url).replace(/([?&]token=)[^&]+/g, '$1REDACTED'),
                  hostname: req.hostname,
                  remoteAddress: req.ip,
                };
              },
            },
            redact: ['req.headers.authorization'],
          },
  });
  // Same-origin by default (UI is served by this server). Set CORS_ORIGIN
  // (comma-separated) only if the UI is hosted on a different origin.
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : false,
  });

  // HTTP observability: request throughput and latency by route + status. The
  // route pattern (not the raw URL) keeps cardinality bounded.
  app.addHook('onResponse', async (req, reply) => {
    const route = (req.routeOptions?.url as string | undefined) ?? 'unmatched';
    const status = String(reply.statusCode);
    metrics.inc('shieldtest_http_requests_total', 'HTTP requests by route and status', {
      method: req.method,
      route,
      status,
    });
    metrics.observe(
      'shieldtest_http_request_duration_ms',
      'HTTP request handling duration (ms) by route',
      reply.elapsedTime,
      { method: req.method, route },
    );
  });

  // Security headers on every response (the app hardens itself, not just its
  // targets). No external origins are used, so the CSP is strict; 'unsafe-inline'
  // is limited to styles (the HTML reports embed a <style> block). The reports'
  // one inline handler — the "Print / PDF" button's onclick="window.print()" —
  // is allowed by its exact hash via 'unsafe-hashes' (only that literal handler,
  // nothing else, so an injected script/handler is still blocked — no XSS hole).
  const PRINT_HANDLER_HASH = "'sha256-MguIPR6qNR8D3B+eAlK+bIRTZe8t3wkOY4B/56Me9FU='";
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-hashes' ${PRINT_HANDLER_HASH}; ` +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  /**
   * Resolves and *revalidates* the caller from their token: existence, status
   * and the token version (so a deleted or disabled user — or one whose
   * password/role changed — is rejected immediately instead of lingering until
   * the token's exp). Env users are the immutable root and skip the store check;
   * share/report tokens are ephemeral viewer grants with no store record.
   */
  type AuthResult =
    | { ok: true; id: { email: string; role: Role }; mustChange: boolean }
    | { ok: false; code: number; error: string };
  async function resolveIdentity(req: FastifyRequest): Promise<AuthResult> {
    const payload = payloadFromRequest(auth, req);
    if (!payload) return { ok: false, code: 401, error: 'authentication required' };
    const email = payload.sub;
    if (email.startsWith('share:')) {
      return { ok: true, id: { email, role: payload.role as Role }, mustChange: false };
    }
    if (auth.users.has(email.toLowerCase())) {
      return { ok: true, id: { email, role: payload.role as Role }, mustChange: false };
    }
    const su = await store.getUser(email.toLowerCase());
    if (!su) return { ok: false, code: 401, error: 'account no longer exists — sign in again' };
    if ((su.status ?? 'active') === 'disabled') {
      return { ok: false, code: 401, error: 'account disabled' };
    }
    if ((payload.ver ?? 0) !== (su.tokenVersion ?? 0)) {
      return { ok: false, code: 401, error: 'session expired — sign in again' };
    }
    return {
      ok: true,
      id: { email: su.email, role: su.role },
      mustChange: !!su.mustChangePassword,
    };
  }

  function guard(perm: Permission) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!auth.enabled) return;
      const r = await resolveIdentity(req);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      req.authUser = r.id;
      if (r.mustChange) {
        return reply
          .code(403)
          .send({ error: 'password change required', code: 'password_change_required' });
      }
      if (!can(r.id.role, perm)) {
        return reply.code(403).send({ error: `missing ${perm} permission` });
      }
    };
  }

  /** Verifies a read token passed in the query (browser links: report, SSE). */
  function readTokenAllowed(req: FastifyRequest): boolean {
    if (!auth.enabled) return true;
    const { token } = req.query as { token?: string };
    const id = token
      ? identityFromRequest(auth, {
          headers: { authorization: `Bearer ${token}` },
        } as FastifyRequest)
      : identityFromRequest(auth, req);
    return id !== null && can(id.role, 'campaign:read');
  }

  if (opts.serveStatic !== false) {
    const frontendDist = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'frontend',
      'dist',
    );
    if (existsSync(frontendDist)) {
      await app.register(fastifyStatic, { root: frontendDist });
      app.log.info(`UI served from ${frontendDist}`);
      // SPA fallback: browser routes (react-router) that are neither /api nor
      // /metrics return index.html (deep links such as /campaigns).
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url && (req.raw.url.startsWith('/api') || req.raw.url.startsWith('/metrics'))) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.sendFile('index.html');
      });
    }
  }

  function fail(err: unknown, reply: FastifyReply) {
    if (err instanceof CampaignError) return reply.code(400).send({ error: err.message });
    if (err instanceof AgentError) return reply.code(503).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  }

  async function auditAs(
    actor: string,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) {
    try {
      await store.saveAudit({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor,
        action,
        campaignId,
        detail,
      });
    } catch (err) {
      app.log.error({ err }, 'failed to write audit entry');
    }
  }
  const audit = (
    req: FastifyRequest,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) => auditAs(req.authUser?.email ?? 'dev', action, campaignId, detail);

  async function runCampaign(c: Campaign, actor: string): Promise<CampaignRun> {
    // Dual control: enforced here so NEITHER the execute endpoint NOR the suite
    // sequencer can bypass a mandatory CISO sign-off.
    if (requireCisoApproval && !c.cisoApprovedBy) {
      throw new CampaignError(
        'CISO sign-off required before this campaign can run (dual control).',
      );
    }
    if (kills.count() >= maxConcurrentRuns) {
      throw new CampaignError(
        `Too many concurrent runs (max ${maxConcurrentRuns}). Try again once one finishes.`,
      );
    }
    // Integrity guardrail: never START a measurement while our own generator host
    // is saturated — a WRS taken on a stalling event loop reflects OUR bottleneck,
    // not the target's protection. The scheduler catches this and retries next
    // tick (campaign stays APPROVED); a manual click gets a clear "try again".
    const startLagMs = metrics.eventLoopLagMs();
    if (startLagMs > EVENT_LOOP_LAG_GUARD_MS) {
      metrics.inc(
        'shieldtest_run_deferred_total',
        'Runs deferred by the integrity guardrail (generator saturated at start)',
        { actor },
      );
      await auditAs(
        actor,
        'campaign.defer',
        c.id,
        `deferred: generator event-loop lag ${Math.round(startLagMs)}ms > ${EVENT_LOOP_LAG_GUARD_MS}ms guard`,
      );
      throw new CampaignError(
        `Generator saturated (event-loop lag ${Math.round(startLagMs)}ms) — deferring to protect measurement integrity. Try again shortly.`,
      );
    }
    // Per-campaign concurrency guard: never start a SECOND run for a campaign
    // that already has one in flight. Without this, a duplicate start (double
    // click, a manual run racing the sequencer) would `kills.set` over the live
    // switch and ORPHAN the first engine loop — it keeps generating load with no
    // registered kill switch, so neither the Kill button nor the timeout can
    // ever stop it (only a process restart). The check + set below run with no
    // await between them, so they are atomic on the single event-loop turn.
    if (kills.get(c.id)) {
      throw new CampaignError(
        'This campaign already has a run in flight — kill or wait for it before starting another.',
      );
    }
    const kill = new KillSwitch();
    kills.set(c.id, kill);
    await store.saveCampaign(transition(c, 'RUNNING'));
    // Per-campaign engine, falling back to the server default agent for an
    // unknown id. The UI offers engines that may not be installed ("→ default");
    // honour that at execution too — fall back to the built-in engine rather than
    // failing the run when the chosen external tool is unavailable.
    let runAgent = createAgent(c.agent) ?? agent;
    if (runAgent !== agent && !(await runAgent.available())) {
      runAgent = agent;
    }
    // Measurement fidelity: the in-process built-in generator caps out ~150 rps
    // and silently under-delivers above it. When a high-rate simple flood would
    // run on the built-in engine, auto-route it to an out-of-process engine
    // (vegeta/k6) that can actually deliver the configured rate — but only if
    // that engine is installed; otherwise keep built-in (still bounded/safe,
    // just rate-limited). See modules/campaigns/engine-route.ts.
    if ((opts.autoRouteHighRps ?? true) && runAgent.name === 'builtin-http') {
      const upgradeId = highRateEngineUpgrade(c, BUILTIN_RPS_CEILING);
      if (upgradeId) {
        const upgraded = createAgent(upgradeId);
        if (upgraded && (await upgraded.available())) {
          app.log.info(
            { evt: 'run.autoroute', campaignId: c.id, to: upgradeId, maxRps: c.maxRps },
            `auto-routed to ${upgradeId} (maxRps ${c.maxRps} > built-in ceiling ${BUILTIN_RPS_CEILING} rps)`,
          );
          runAgent = upgraded;
        }
      }
    }
    // Track the worst event-loop lag seen during the run so we can flag the WRS
    // as measurement-degraded if the generator host was itself struggling.
    let peakEventLoopLagMs = 0;
    // Live per-run gauges (updated every tick) so Grafana animates the run in
    // real time, mirroring the app's Run Theater — offered/reached-origin RPS,
    // absorbed ratio and legit-probe availability. The settle-time `_last`
    // gauges keep the post-run summary; these `_live` series are retired when the
    // run ends (see the finally block) so a finished run leaves no stale line.
    let liveHost = c.target;
    try {
      liveHost = new URL(c.target).hostname;
    } catch {
      /* keep raw */
    }
    const liveLabels = { target: liveHost, vector: c.vector };
    const onProgress = (p: LoadProgress) => {
      const lag = metrics.eventLoopLagMs();
      if (lag > peakEventLoopLagMs) peakEventLoopLagMs = lag;
      liveProgress.set(c.id, {
        ...p,
        maxDurationSec: c.maxDurationSec,
        status: 'RUNNING',
        engine: runAgent.name,
      });
      // Same definitions the Run Theater cards use (see frontend RunTheater):
      // offered = achieved RPS, reached-origin = successful/elapsed, absorbed =
      // failed/sent, probe availability from the live probe snapshot.
      const originRps = p.elapsedSec > 0 ? p.successful / p.elapsedSec : 0;
      const absorbed = p.sent > 0 ? p.failed / p.sent : 0;
      metrics.setGauge(
        'shieldtest_run_live_offered_rps',
        'Live offered RPS of the in-flight run',
        p.actualRps,
        liveLabels,
      );
      metrics.setGauge(
        'shieldtest_run_live_origin_rps',
        'Live RPS reaching origin (successful) of the in-flight run',
        originRps,
        liveLabels,
      );
      metrics.setGauge(
        'shieldtest_run_live_absorbed_ratio',
        'Live absorbed ratio (failed/sent) of the in-flight run',
        absorbed,
        liveLabels,
      );
      if (p.probe && p.probe.samples > 0) {
        metrics.setGauge(
          'shieldtest_run_live_probe_avail_pct',
          'Live legit-probe availability % of the in-flight run',
          (p.probe.available / p.probe.samples) * 100,
          liveLabels,
        );
      }
    };
    // Seed a zeroed progress record immediately: the run opens with a baseline
    // capture (awaited, a few seconds) during which the engine emits no
    // progress. Without this seed the live stream would find no record and tell
    // the UI the run is "done", stranding the progress view on "Starting run…".
    // Cleared in the finally below; onProgress overwrites it once load begins.
    onProgress({ sent: 0, successful: 0, failed: 0, elapsedSec: 0, actualRps: 0 });
    try {
      let host = c.target;
      try {
        host = new URL(c.target).hostname;
      } catch {
        /* keep raw */
      }
      const runStartedMs = Date.now();
      metrics.addGauge('shieldtest_runs_in_flight', 'Campaign runs currently executing', 1);
      app.log.info(
        {
          evt: 'run.start',
          campaignId: c.id,
          campaign: c.name,
          target: host,
          engine: runAgent.name,
          maxRps: c.maxRps,
          maxDurationSec: c.maxDurationSec,
          phases: c.scenario?.length ?? 0,
        },
        `run.start ${c.name}`,
      );
      const run = await executeCampaign(
        c,
        allowedTargets,
        kill,
        onProgress,
        runAgent,
        protection,
        undefined,
        targetTelemetry,
      );
      const runDurationSec = (Date.now() - runStartedMs) / 1000;
      metrics.addGauge('shieldtest_runs_in_flight', 'Campaign runs currently executing', -1);
      metrics.inc('shieldtest_runs_completed_total', 'Runs by terminal status', {
        status: run.status,
        engine: runAgent.name,
      });
      metrics.observe(
        'shieldtest_run_duration_seconds',
        'Wall-clock duration of a campaign run',
        runDurationSec,
        { engine: runAgent.name },
      );
      // Slice run-outcome metrics by target AND vector (attack shape) — a bounded
      // extra label so Grafana can answer "which shapes does this edge absorb?".
      const runLabels = { target: host, vector: c.vector };
      metrics.setGauge('shieldtest_run_wrs_last', 'Last WRS per target', run.wrs.wrs, runLabels);
      // Protection-absorption metrics: how much of the offered load the target's
      // edge absorbed (rate-limited/tarpitted/4xx) vs let through to origin.
      // Single source of truth (computeAbsorption) shared with the report + UI.
      // Break absorption down by mechanism: rejected = 4xx/5xx (edge answered a
      // refusal), tarpitted = transport errors (edge held the connection).
      const gStatus = run.generator.statusCounts ?? {};
      const rejected = Object.entries(gStatus)
        .filter(([b]) => b !== '2xx' && b !== '3xx')
        .reduce((s, [, n]) => s + n, 0);
      const tarpitted = Object.values(run.generator.errors ?? {}).reduce((s, n) => s + n, 0);
      const absorption = computeAbsorption({
        configuredRps: c.maxRps,
        achievedRps: run.generator.actualRps,
        totalRequests: run.generator.totalRequests,
        successful: run.generator.successful,
        failed: run.generator.failed,
        durationSec: runDurationSec,
        rejected,
        tarpitted,
      });
      metrics.setGauge(
        'shieldtest_run_configured_rps_last',
        'Configured max RPS of the last run per target',
        absorption.configuredRps,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_achieved_rps_last',
        'Achieved (sent) RPS of the last run per target',
        absorption.achievedRps,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_origin_rps_last',
        'RPS that reached origin (2xx/3xx) in the last run per target',
        absorption.originRps,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_absorbed_ratio_last',
        'Fraction of requests absorbed by the target edge (rate-limited/tarpitted/4xx) in the last run',
        absorption.absorbedRatio,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_rejected_ratio_last',
        'Fraction the edge REJECTED with a 4xx/5xx response in the last run',
        absorption.rejectedRatio,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_tarpit_ratio_last',
        'Fraction the edge TARPITTED (held → timeout/abort) in the last run',
        absorption.tarpitRatio,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_offered_shortfall_last',
        'Backpressure: 1 - achieved/configured RPS (latency-bound, not edge rejection)',
        absorption.offeredShortfall,
        runLabels,
      );
      if (run.generator.hardStopped) {
        metrics.inc(
          'shieldtest_loadtest_hard_stopped_total',
          'Runs force-settled by the hard backstop (target held connections past the cap)',
          { ...runLabels, engine: runAgent.name },
        );
      }
      // Measurement confidence: was the generator host the bottleneck (hard-stop
      // or high event-loop lag during the run)? If so, badge the WRS as degraded.
      run.absorption = absorption;
      run.confidence = computeConfidence({
        hardStopped: run.generator.hardStopped,
        peakEventLoopLagMs,
      });
      if (run.confidence.degraded) {
        metrics.inc(
          'shieldtest_run_confidence_degraded_total',
          'Runs whose WRS is flagged measurement-degraded (generator-side bottleneck)',
          runLabels,
        );
      }
      // Bilateral corroboration (I1): if an edge source is configured, compare our
      // inferred absorption with the edge's own reported blocked/seen counts.
      if (edgeAbsorption.configured) {
        const edge = await edgeAbsorption
          .report({
            campaignId: c.id,
            target: c.target,
            startedAt: run.generator.startedAt,
            finishedAt: run.generator.finishedAt,
            tag: c.id,
          })
          .catch(() => null);
        if (edge) {
          const corr = corroborate(absorption.absorbedRatio, edge);
          run.edgeCorroboration = corr;
          metrics.setGauge(
            'shieldtest_run_edge_absorbed_ratio_last',
            'Absorbed fraction reported by the target edge itself (bilateral corroboration)',
            corr.edgeAbsorbedRatio,
            runLabels,
          );
          metrics.setGauge(
            'shieldtest_run_absorption_agreement_last',
            'Agreement between our inferred absorption and the edge report (1 - |delta|)',
            1 - corr.agreementDelta,
            runLabels,
          );
        }
      }
      app.log.info(
        {
          evt: 'run.settled',
          campaignId: c.id,
          runId: run.runId,
          target: host,
          status: run.status,
          statusDetail: run.statusDetail,
          wrs: run.wrs.wrs,
          grade: run.wrs.level,
          durationSec: Number(runDurationSec.toFixed(1)),
          requests: run.generator.totalRequests,
          successful: run.generator.successful,
          failed: run.generator.failed,
          actualRps: run.generator.actualRps,
          configuredRps: c.maxRps,
        },
        `run.settled ${c.name} → ${run.status} · WRS ${run.wrs.wrs} in ${runDurationSec.toFixed(1)}s`,
      );
      await store.saveRun(run);
      // Publish the last run's probe health as Prometheus gauges, labelled by
      // target, so Grafana can chart/alert on measured availability, latency and
      // error rate — closing the loop with the monitoring stack (these otherwise
      // live only inside the run record). Best-effort: never break a settle.
      try {
        let target = c.target;
        try {
          target = new URL(c.target).hostname;
        } catch {
          /* keep raw target label */
        }
        const availPct = run.probe.samples ? (run.probe.available / run.probe.samples) * 100 : 100;
        metrics.setGauge(
          'shieldtest_probe_availability_pct',
          'Last run: legitimate-probe availability (%) by target',
          Number(availPct.toFixed(1)),
          { target },
        );
        metrics.setGauge(
          'shieldtest_probe_latency_p95_ms',
          'Last run: legitimate-probe p95 latency (ms) by target',
          run.probe.latencyMs.p95,
          { target },
        );
        metrics.setGauge(
          'shieldtest_probe_error_rate_5xx_pct',
          'Last run: legitimate-probe 5xx error rate (%) by target',
          run.probe.errorRate5xx,
          { target },
        );
      } catch (err) {
        app.log.warn({ err }, 'failed to publish probe gauges');
      }
      // Recurring campaigns re-arm for their next run (within the approval
      // window); otherwise the campaign settles into its terminal run status.
      const rearm = reArmRecurring(c, Date.now());
      await store.saveCampaign({
        ...c,
        status: rearm ? 'APPROVED' : run.status,
        scheduledAt: rearm ? rearm.scheduledAt : c.scheduledAt,
        wrs: run.wrs,
        acceptanceResult: run.acceptance,
        runId: run.runId,
        statusDetail: rearm ? undefined : run.statusDetail,
        startedAt: run.generator.startedAt,
        finishedAt: run.generator.finishedAt,
        durationSec: Number(runDurationSec.toFixed(1)),
      });
      await auditAs(
        actor,
        'campaign.execute',
        c.id,
        `${run.status}${run.statusDetail ? ` — ${run.statusDetail}` : ''} · WRS ${run.wrs.wrs} (${run.wrs.level})`,
      );
      // Notify the team (opt-in sink): outcome + regression. Never let a failing
      // sink break the run — notifications are best-effort.
      try {
        const [allCampaigns, allRuns] = await Promise.all([
          store.listCampaigns(),
          store.listRuns(),
        ]);
        const series = buildWrsHistory(allCampaigns, allRuns).find((s) => s.target === host);
        // Baseline drift: the most recent previous run against the same target
        // that carries a baseline (recurring campaigns re-run the same target).
        const targetHostOf = (cid: string): string => {
          const t = allCampaigns.find((cc) => cc.id === cid)?.target ?? '';
          try {
            return new URL(t).hostname;
          } catch {
            return t;
          }
        };
        const previousBaseline = allRuns
          .filter((r) => r.runId !== run.runId && r.baseline && targetHostOf(r.campaignId) === host)
          .sort((a, b) =>
            b.generator.finishedAt.localeCompare(a.generator.finishedAt),
          )[0]?.baseline;
        for (const ev of buildRunNotifications(c, run, series, previousBaseline)) {
          await notifier.notify(ev);
        }
      } catch (err) {
        app.log.error({ err }, 'failed to emit notifications');
      }
      return run;
    } catch (err) {
      await store.saveCampaign(transition(c, 'APPROVED'));
      throw err;
    } finally {
      liveProgress.clear(c.id);
      kills.clear(c.id);
      // Retire the live per-run gauges — the run is over; its summary lives in
      // the settle-time `_last` gauges. Leaving these would strand a finished
      // run's last value as a stale flat line on the Grafana live panels.
      for (const g of [
        'shieldtest_run_live_offered_rps',
        'shieldtest_run_live_origin_rps',
        'shieldtest_run_live_absorbed_ratio',
        'shieldtest_run_live_probe_avail_pct',
      ]) {
        metrics.clearGauge(g, liveLabels);
      }
    }
  }

  // --- Multi-step suite sequencer -------------------------------------------
  // A playbook instantiates into an ordered set of campaigns linked by suiteId.
  // This runs them one at a time in suiteOrder, awaiting each step's terminal
  // state before starting the next, and — crucially — advancing PAST a step that
  // auto-kills (an availability loss on one vector must not strand the rest of
  // the assessment). Governed one-click: the runner approves each pending step
  // (author≠approver still enforced by approveCampaign — a step the runner
  // authored is skipped and audited), then executes it. Runs in the background;
  // progress is read from the member campaigns' statuses. One sequence per suite.
  //
  // A sequence is controllable while it runs: PAUSE holds it between steps
  // (the current step finishes, the next does not start) until RESUME; CANCEL
  // stops it and kills the step in flight. The control lives in `suiteRuns` and
  // is exposed via GET /api/suites/sequences so the UI can render the state.
  interface SuiteControl {
    paused: boolean;
    cancelled: boolean;
    /** The member campaign currently executing (for a cancel to kill it). */
    current?: string;
    total: number;
    started: number;
    /** Consecutive recovery-gate skips because the target stayed unreachable. */
    downSkips: number;
    /** Paused by the sequencer itself because the target looked genuinely down
     *  (as opposed to a manual pause). Cleared on resume. */
    autoPaused?: boolean;
  }
  // Auto-pause the whole sequence after this many consecutive gate-skips for an
  // unreachable target — the origin looks genuinely DOWN, so stop grinding
  // through skips (and never risk relaunching load onto a downed host) and wait
  // for an operator instead of the target's brief recovery.
  const AUTO_PAUSE_AFTER_DOWN_SKIPS = 2;
  const suiteRuns = new Map<string, SuiteControl>();
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Reserve a suite's run slot synchronously (atomic guard). Returns null if a
   *  sequence is already registered for it — the caller must 409. Reserving
   *  before any `await` is what prevents a double-submit from starting two
   *  concurrent sequences (which would run two steps at once). */
  function reserveSuiteRun(suiteId: string): SuiteControl | null {
    if (suiteRuns.has(suiteId)) return null;
    const ctrl: SuiteControl = {
      paused: false,
      cancelled: false,
      total: 0,
      started: 0,
      downSkips: 0,
    };
    suiteRuns.set(suiteId, ctrl);
    return ctrl;
  }

  async function runSuiteSequence(
    suiteId: string,
    actor: string,
    reserved?: SuiteControl,
  ): Promise<void> {
    // Use the pre-reserved control when the caller already claimed the slot
    // (the /run endpoint does, synchronously); otherwise claim it now.
    const ctrl = reserved ?? reserveSuiteRun(suiteId);
    if (!ctrl) return; // a sequence is already running for this suite
    try {
      const members = (await store.listCampaigns())
        .filter((c) => c.suiteId === suiteId)
        .sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
      ctrl.total = members.length;
      for (const m of members) {
        if (ctrl.cancelled) break;
        // Pause gate: hold between steps while paused (a cancel breaks out).
        while (ctrl.paused && !ctrl.cancelled) await sleepMs(400);
        if (ctrl.cancelled) break;
        // Re-fetch: earlier steps may have changed state (and to see manual kills).
        let c = await store.getCampaign(m.id);
        if (!c) continue;
        if (c.status === 'PENDING_APPROVAL') {
          try {
            c = approveCampaign(c, actor, 'APPROVED');
            await store.saveCampaign(c);
            await auditAs(actor, 'campaign.approve', c.id, `suite ${suiteId} sequence`);
          } catch (err) {
            await auditAs(actor, 'suite.skip', c.id, `not approved: ${(err as Error).message}`);
            continue;
          }
        }
        if (c.status !== 'APPROVED') continue; // terminal / rejected → leave as-is
        // Recovery gate BETWEEN waves: once at least one step has run, don't start
        // the next wave until the target is reachable again (it may still be
        // recovering from the previous load). Bounded, so the suite never hangs;
        // if the target never recovers we skip the step rather than hammer a down
        // target. The wait time is recorded (a real recovery-time signal).
        if (opts.suiteRecovery !== false && ctrl.started > 0 && !ctrl.cancelled) {
          const gate = await waitForTargetAvailable(c.probeUrl || c.target, {
            isCancelled: () => ctrl.cancelled,
            ...(typeof opts.suiteRecovery === 'object' ? opts.suiteRecovery : {}),
          });
          const secs = Math.round(gate.waitedMs / 1000);
          if (!gate.available) {
            ctrl.downSkips += 1;
            await auditAs(actor, 'suite.skip', c.id, `target unavailable after ${secs}s — skipped`);
            // The target looks genuinely DOWN (repeated failed recovery). Stop
            // grinding through skips and auto-pause the whole sequence — never
            // keep cycling load attempts against a downed origin; wait for an
            // operator to resume once it is back.
            if (ctrl.downSkips >= AUTO_PAUSE_AFTER_DOWN_SKIPS && !ctrl.paused) {
              ctrl.paused = true;
              ctrl.autoPaused = true;
              await auditAs(
                actor,
                'suite.pause',
                c.id,
                `origin unreachable — auto-paused after ${ctrl.downSkips} consecutive skips (protecting the target)`,
              );
            }
            continue;
          }
          ctrl.downSkips = 0;
          await auditAs(actor, 'suite.gate', c.id, `target available after ${secs}s — proceeding`);
        }
        if (ctrl.cancelled) break;
        ctrl.current = c.id;
        ctrl.started += 1;
        try {
          await runCampaign(c, actor); // awaits the step's terminal state
        } catch (err) {
          // A failed/blocked step still advances the sequence.
          await auditAs(actor, 'suite.skip', c.id, `run error: ${(err as Error).message}`);
        } finally {
          ctrl.current = undefined;
        }
      }
    } finally {
      suiteRuns.delete(suiteId);
    }
  }

  app.get('/health', async () => ({
    status: 'ok',
    // Build stamp of THIS running server — lets you confirm which commit the API
    // actually serves (the frontend footer only reflects the bundle it shipped).
    version: getBuildInfo(),
    // Governance posture: does this deployment require a CISO sign-off on every
    // campaign (dual control)? The UI reads this to show/gate the CISO step.
    requireCisoApproval,
    allowedTargets,
    labTargets,
    storage: store.backend,
    authRequired: auth.enabled,
    agent: agent.name,
    notifications: notifier.sinks,
    protection: protection.configured,
    targetTelemetry: targetTelemetry.configured,
    tlsInsecure: tlsInsecure(),
    // `hardCaps` = the EFFECTIVE operational caps the server enforces right now
    // (the CISO-set limits, or the ceiling when unset). The frontend reads these
    // for its inline hints, so it always matches enforcement. `hardCapsCeiling`
    // is the immutable absolute ceiling (config/limits.ts) — the CISO can never
    // set an operational cap above it.
    hardCaps: effectiveCaps,
    hardCapsCeiling: { ...HARD_CAPS },
  }));

  // Operational limits (the effective caps) and the immutable ceiling. Any
  // authenticated reader can see them; only the CISO can change them.
  app.get('/api/limits', { preHandler: guard('campaign:read') }, async () => ({
    ceiling: { ...HARD_CAPS },
    effective: effectiveCaps,
  }));

  // CISO-only: set the operational limits. They are validated to be integers
  // within [1, ceiling] and re-clamped server-side, so they can NEVER exceed the
  // immutable HARD_CAPS ceiling (defense in depth). The change is audited.
  app.put('/api/limits', { preHandler: guard('limits:manage') }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<HardCaps>;
    if (!withinCeiling(body)) {
      return reply.code(400).send({
        error:
          'Each limit must be an integer within [1, ceiling]. ' +
          `Ceiling: maxRps ${HARD_CAPS.maxRps}, maxConcurrency ${HARD_CAPS.maxConcurrency}, ` +
          `maxDurationSec ${HARD_CAPS.maxDurationSec}.`,
      });
    }
    const next = clampToCeiling(body); // withinCeiling already true; clamp is belt-and-braces
    await store.setLimits(next);
    effectiveCaps = next;
    await audit(
      req,
      'limits.update',
      undefined,
      `operational limits set: maxRps=${next.maxRps}, maxConcurrency=${next.maxConcurrency}, ` +
        `maxDurationSec=${next.maxDurationSec} (ceiling ${HARD_CAPS.maxRps}/${HARD_CAPS.maxConcurrency}/${HARD_CAPS.maxDurationSec})`,
    );
    return reply.send({ ceiling: { ...HARD_CAPS }, effective: effectiveCaps });
  });

  // Readiness probe: 503 when the store is unreachable (e.g. DB down), so a
  // load balancer / monitor can tell "process up" from "actually serving".
  app.get('/ready', async (_req, reply) => {
    const ok = await store.healthy();
    return reply.code(ok ? 200 : 503).send({ ready: ok, storage: store.backend });
  });

  // Send a test notification so operators can verify their sink is wired up.
  app.post('/api/notify/test', { preHandler: guard('campaign:create') }, async (_req, reply) => {
    if (notifier.sinks.length === 0) {
      return reply.code(400).send({ error: 'no notification sink configured' });
    }
    await notifier.notify({
      kind: notifier.events[0] ?? 'campaign.completed',
      severity: 'info',
      title: '🔔 ShieldTest test notification',
      text: 'Test notification from WEDOS ShieldTest — your sink is wired up correctly.',
      at: new Date().toISOString(),
      fields: [{ label: 'Sinks', value: notifier.sinks.join(', ') }],
    });
    return { delivered: true, sinks: notifier.sinks };
  });

  // Load engines and their live availability (bounded HTTP, delegated tools).
  app.get('/api/agents', async () => {
    const list = await describeAgents();
    return { default: agent.name, agents: list };
  });

  // Preparation-phase reconnaissance: passive + published-surface recon of an
  // allowlisted, authorized target → target profile, real path set, pre-test
  // baseline, preflight go/no-go, and the seeded gap-analyzer profile. Bounded
  // and non-intrusive (no scan / fuzz / enumeration). See modules/recon.
  app.get('/api/recon', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const { target, probeUrl } = req.query as { target?: string; probeUrl?: string };
    if (!target) return reply.code(400).send({ error: 'target is required' });
    const engines = (await describeAgents()).filter((a) => a.available).length;
    try {
      return await runRecon(target, probeUrl ?? target, allowedTargets, {
        enginesAvailable: engines,
        capsConfigured: true,
        protectionConfigured: protection.configured,
        labRunnerConfigured: labTargets.length > 0,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Best-effort recon used to seed a suite's endpoints from the target's real
  // published surface (systematic recon). Never throws: on failure the caller
  // falls back to the template paths and the summary says so.
  interface ReconSeedResult {
    surface?: { paths: string[]; loginPath?: string };
    summary: {
      seeded: boolean;
      go?: boolean;
      suggestedPaths?: string[];
      loginPath?: string;
      error?: string;
    };
  }
  // Recon makes real network requests; cap the total so instantiation/composition
  // can never hang on a slow or unreachable target (it just falls back to the
  // template paths). Kept short so a launch stays responsive.
  const RECON_SEED_TIMEOUT_MS = 8000;
  async function reconSeed(target: string, probeUrl: string): Promise<ReconSeedResult> {
    try {
      const availN = (await describeAgents()).filter((a) => a.available).length;
      const recon = await Promise.race([
        runRecon(target, probeUrl, allowedTargets, {
          enginesAvailable: availN,
          capsConfigured: true,
          protectionConfigured: protection.configured,
          labRunnerConfigured: labTargets.length > 0,
        }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('recon timed out')), RECON_SEED_TIMEOUT_MS);
          t.unref?.();
        }),
      ]);
      return {
        surface: { paths: recon.suggestedPaths, loginPath: recon.loginPath },
        summary: {
          seeded: true,
          go: recon.preflight.go,
          suggestedPaths: recon.suggestedPaths,
          loginPath: recon.loginPath,
        },
      };
    } catch (err) {
      return { summary: { seeded: false, error: (err as Error).message } };
    }
  }

  // Anti-brute-force: temporary lock after several failures (per email+IP).
  const loginFails = new Map<string, { count: number; until: number }>();
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  app.post('/api/auth/login', async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication disabled' });
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' });
    const key = `${email.toLowerCase()}|${req.ip}`;
    const entry = loginFails.get(key);
    if (entry && entry.count >= MAX_FAILS && Date.now() < entry.until) {
      return reply.code(429).send({ error: 'too many attempts — try again later' });
    }
    const rejectLogin = async (reason: string, actor: string) => {
      const count = (entry?.count ?? 0) + 1;
      loginFails.set(key, { count, until: Date.now() + LOCK_MS });
      req.log.warn({ email: email.toLowerCase(), ip: req.ip, reason }, 'login failed');
      // Only the lock event reaches the (tamper-evident) audit chain, not every
      // attempt — enough to flag an attack without flooding the governance log.
      if (count === MAX_FAILS) {
        await auditAs(
          actor,
          'auth.login_locked',
          undefined,
          `${count} failed attempts (${reason})`,
        );
      }
      return reply.code(401).send({ error: 'invalid credentials' });
    };

    // Env-defined users first (immutable root); then runtime store users.
    let res = login(auth, email, password);
    let mustChangePassword = false;
    if (res) {
      await auditAs(res.email, 'auth.login', undefined, 'env user');
    } else {
      const su = await store.getUser(email.toLowerCase());
      if (su && verifyPassword(password, su.passwordHash)) {
        // Correct credentials but a deactivated account: refuse with the same
        // generic message (no oracle), and record the reason out of band.
        if ((su.status ?? 'active') === 'disabled') {
          return rejectLogin('account disabled', su.email);
        }
        await store.recordLogin(su.email, new Date().toISOString());
        mustChangePassword = !!su.mustChangePassword;
        res = {
          token: signJwt({ sub: su.email, role: su.role, ver: su.tokenVersion ?? 0 }, auth.secret),
          email: su.email,
          role: su.role,
        };
        await auditAs(su.email, 'auth.login', undefined, undefined);
      }
    }
    if (!res) return rejectLogin('bad credentials', email.toLowerCase());
    loginFails.delete(key);
    return { ...res, mustChangePassword };
  });

  // Best-effort logout record. A stateless JWT can't be revoked server-side, so
  // this only writes an audit trail; the client discards the token. (Immediate
  // revocation on deactivation/password change is handled by resolveIdentity.)
  app.post('/api/auth/logout', async (req, reply) => {
    if (!auth.enabled) return { ok: true };
    const r = await resolveIdentity(req);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    req.authUser = r.id;
    await audit(req, 'auth.logout', undefined, undefined);
    return { ok: true };
  });

  // Self-service password change — works even while a forced change is pending.
  // Store users only (env passwords are managed via configuration). Bumps the
  // revocation epoch (killing other sessions) and returns a fresh token so the
  // current session survives.
  app.post('/api/auth/password', async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    const r = await resolveIdentity(req);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    req.authUser = r.id;
    const body = req.body as { currentPassword?: string; newPassword?: string };
    const email = r.id.email.toLowerCase();
    if (auth.users.has(email)) {
      return reply
        .code(400)
        .send({ error: 'Your account is managed via configuration and cannot self-change here.' });
    }
    const su = await store.getUser(email);
    if (!su) return reply.code(404).send({ error: 'user not found' });
    if (!verifyPassword(body.currentPassword ?? '', su.passwordHash)) {
      return reply.code(400).send({ error: 'Current password is incorrect.' });
    }
    const newPassword = body.newPassword ?? '';
    const problem = passwordProblem(newPassword, email);
    if (problem) return reply.code(400).send({ error: problem });
    if (verifyPassword(newPassword, su.passwordHash)) {
      return reply.code(400).send({ error: 'New password must differ from the current one.' });
    }
    const nextVer = (su.tokenVersion ?? 0) + 1;
    await store.saveUser({
      ...su,
      passwordHash: hashPassword(newPassword),
      mustChangePassword: false,
      tokenVersion: nextVer,
    });
    await audit(req, 'password.change', undefined, email);
    // Other sessions (old version) are now revoked; this fresh token carries the
    // new version so the current session survives.
    const token = signJwt({ sub: su.email, role: su.role, ver: nextVer }, auth.secret);
    return { token, email: su.email, role: su.role, mustChangePassword: false };
  });

  // Mint a short-lived, read-only share token for report links. Downgraded to
  // the viewer role regardless of the caller — a share link can only read.
  app.post('/api/share', { preHandler: guard('campaign:read') }, async (req, reply) => {
    if (!auth.enabled) {
      return reply.send({ authRequired: false, token: null, expiresAt: null });
    }
    const { ttlMinutes } = (req.body ?? {}) as { ttlMinutes?: number };
    const ttlMin = Math.min(Math.max(Math.round(Number(ttlMinutes) || 60), 1), 7 * 24 * 60);
    const token = signJwt(
      { sub: `share:${req.authUser?.email ?? 'anon'}`, role: 'viewer' },
      auth.secret,
      ttlMin * 60,
    );
    await audit(req, 'share.create', undefined, `read-only share link (${ttlMin} min)`);
    return reply.send({
      authRequired: true,
      token,
      ttlMinutes: ttlMin,
      expiresAt: new Date(Date.now() + ttlMin * 60_000).toISOString(),
    });
  });

  // DRS validation verdict (classes A/B, lab-only) — records the outcome of an
  // externally-executed validation into the tamper-evident audit trail. The
  // control plane never runs the attack (drs-validation-policy.md); it records.
  app.post(
    '/api/drs-validations',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      if (labTargets.length === 0) {
        return reply
          .code(400)
          .send({ error: 'DRS validation is disabled (no LAB_TARGETS configured).' });
      }
      const b = (req.body ?? {}) as {
        technique?: string;
        class?: string;
        labTarget?: string;
        outcome?: string;
        detectionSec?: number;
        mitigationSec?: number;
        runner?: string;
      };
      const cls = String(b.class ?? '').toUpperCase();
      if (cls !== 'A' && cls !== 'B') {
        return reply
          .code(400)
          .send({ error: 'class must be A or B (class C is out of scope — network bench).' });
      }
      if (!b.technique?.trim()) return reply.code(400).send({ error: 'technique is required.' });
      const OUTCOMES = ['MITIGATED', 'NOT_MITIGATED', 'INCONCLUSIVE', 'ABORTED'];
      const outcome = String(b.outcome ?? '').toUpperCase();
      if (!OUTCOMES.includes(outcome)) {
        return reply.code(400).send({ error: `outcome must be one of ${OUTCOMES.join(', ')}.` });
      }
      let host = String(b.labTarget ?? '').trim();
      try {
        host = new URL(host).hostname;
      } catch {
        /* not a URL — treat as a bare host */
      }
      // Fail-closed target isolation: must be a lab host, never a production one.
      if (!host || !labTargets.includes(host) || allowedTargets.includes(host)) {
        return reply.code(400).send({
          error:
            'labTarget must be an isolated LAB_TARGETS host (never a production allowlist host).',
        });
      }
      const detail =
        `${cls}/${b.technique} @ ${host} → ${outcome}` +
        (typeof b.detectionSec === 'number' ? ` · TTD ${b.detectionSec}s` : '') +
        (typeof b.mitigationSec === 'number' ? ` · TTM ${b.mitigationSec}s` : '') +
        (b.runner ? ` · runner ${b.runner}` : '');
      await audit(req, 'drs.verdict', undefined, detail);
      return reply.code(201).send({
        recorded: true,
        class: cls,
        technique: b.technique,
        labTarget: host,
        outcome,
        at: new Date().toISOString(),
      });
    },
  );

  // --- Network bench (class C): governed record-and-dispatch -----------------
  // The control plane records a CISO-authorized run request and serves it to an
  // ISOLATED external runner (the shieldtest-lab). It NEVER executes the scenario
  // or emits any traffic (drs-validation-policy.md). Dispatch is fail-closed:
  // disabled unless BOTH a LAB_TARGETS host and a runner token are configured.
  const benchDispatchEnabled = () => labTargets.length > 0 && !!opts.benchRunnerToken;

  /** Resolve + isolate a bench labTarget: must be a LAB host, never production. */
  function benchLabTarget(raw: string): string | null {
    let host = String(raw ?? '').trim();
    try {
      host = new URL(host).hostname;
    } catch {
      /* bare host */
    }
    if (!host || !labTargets.includes(host) || allowedTargets.includes(host)) return null;
    return host;
  }

  /** Runner auth: a dedicated bearer token, never a user JWT. Constant-time compare. */
  function runnerAuthed(req: FastifyRequest): boolean {
    const tok = opts.benchRunnerToken;
    if (!tok) return false;
    const got = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${tok}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  app.get('/api/bench/scenarios', { preHandler: guard('bench:read') }, async () => ({
    scenarios: BENCH_SCENARIOS,
    dispatchEnabled: benchDispatchEnabled(),
    labTargets,
  }));

  app.get('/api/bench/runs', { preHandler: guard('bench:read') }, async () => ({
    runs: await store.listBenchRuns(),
  }));

  app.get('/api/bench/runs/:id', { preHandler: guard('bench:read') }, async (req, reply) => {
    const run = await store.getBenchRun((req.params as { id: string }).id);
    return run ? run : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/bench/runs', { preHandler: guard('bench:dispatch') }, async (req, reply) => {
    if (!benchDispatchEnabled()) {
      return reply.code(400).send({
        error: 'bench dispatch is disabled (configure LAB_TARGETS and BENCH_RUNNER_TOKEN).',
      });
    }
    const b = (req.body ?? {}) as { scenario?: string; labTarget?: string };
    if (!isKnownBenchScenario(b.scenario)) {
      return reply.code(400).send({
        error:
          'scenario must be a reproducible bench vector (UDP amplification/rate). TCP/GRE/spoofing/fragmentation vectors are out of this bench’s model.',
      });
    }
    // labTarget defaults to the sole LAB host when exactly one is configured.
    const rawTarget = b.labTarget ?? (labTargets.length === 1 ? labTargets[0] : '');
    const host = benchLabTarget(rawTarget);
    if (!host) {
      return reply.code(400).send({
        error:
          'labTarget must be an isolated LAB_TARGETS host (never a production allowlist host).',
      });
    }
    const run: BenchRun = {
      id: randomUUID(),
      scenario: b.scenario,
      labTarget: host,
      status: 'REQUESTED',
      requestedBy: req.authUser?.email ?? 'dev',
      requestedAt: new Date().toISOString(),
    };
    await store.createBenchRun(run);
    await audit(req, 'bench.request', undefined, `C/${run.scenario} @ ${host} → REQUESTED`);
    return reply.code(201).send(run);
  });

  // Runner API — an isolated external runner claims work and posts verdicts.
  // Authenticated by BENCH_RUNNER_TOKEN (bearer), never a user JWT.
  app.post('/api/bench/runs/next/claim', async (req, reply) => {
    if (!runnerAuthed(req))
      return reply.code(401).send({ error: 'runner authentication required' });
    const runnerId = (((req.body ?? {}) as { runner?: string }).runner ?? 'runner').slice(0, 120);
    const run = await store.claimNextBenchRun(runnerId);
    if (!run) return reply.code(204).send();
    return reply.code(200).send(run);
  });

  app.post('/api/bench/runs/:id/result', async (req, reply) => {
    if (!runnerAuthed(req))
      return reply.code(401).send({ error: 'runner authentication required' });
    const id = (req.params as { id: string }).id;
    const existing = await store.getBenchRun(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    // A verdict is accepted only for a run currently being executed (CLAIMED).
    // This makes result-posting idempotent-safe: a duplicate or late post can't
    // overwrite a terminal run or record a second MEASURED_LAB coverage row.
    if (existing.status !== 'CLAIMED') {
      return reply
        .code(409)
        .send({ error: `run is ${existing.status}, not CLAIMED — cannot post a result` });
    }
    const b = (req.body ?? {}) as { verdict?: unknown; error?: string };
    if (b.error && !b.verdict) {
      const updated = await store.setBenchRunResult(id, { error: String(b.error).slice(0, 500) });
      await auditAs(
        existing.claimedBy ?? 'runner',
        'bench.verdict',
        undefined,
        `C/${existing.scenario} @ ${existing.labTarget} → FAILED`,
      );
      return reply.code(200).send(updated);
    }
    let verdict;
    try {
      verdict = parseBenchVerdict(b.verdict, existing.scenario);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const updated = await store.setBenchRunResult(id, { verdict });
    // A real run also records MEASURED_LAB coverage for its vector, so the
    // coverage matrix reflects what was actually measured in the lab.
    const drs = BENCH_SCENARIOS.find((s) => s.id === existing.scenario)?.drs;
    await store.saveBenchCoverage({
      id: randomUUID(),
      vector: existing.scenario,
      method: 'MEASURED_LAB',
      outcome: verdict.outcome,
      drs,
      summary: verdict.connections
        ? `Bounded synthetic run (no-spoof) — state-table saturation ${
            verdict.connections.saturationPct ?? '?'
          }% at peak ${verdict.connections.concurrentPeak ?? '?'} conns.`
        : `Bounded synthetic run — amplification ${verdict.amplificationFactor ?? '?'}×${
            verdict.mitigation ? `, collateral ${verdict.mitigation.collateralPct ?? '?'}%` : ''
          }.`,
      source: existing.claimedBy ?? 'shieldtest-lab',
      recordedBy: existing.claimedBy ?? 'runner',
      at: new Date().toISOString(),
    });
    await auditAs(
      existing.claimedBy ?? 'runner',
      'bench.verdict',
      undefined,
      `C/${existing.scenario} @ ${existing.labTarget} → ${verdict.outcome ?? 'COMPLETED'} · amp ${verdict.amplificationFactor ?? '?'}x`,
    );
    return reply.code(200).send(updated);
  });

  // Coverage evidence for a vector by a non-run method (ingested external
  // verdict, control attestation, modelled/replay judgement). CISO records it;
  // the control plane emits nothing. Applies to out-of-model vectors too.
  app.get('/api/bench/coverage', { preHandler: guard('bench:read') }, async () => ({
    coverage: await store.listBenchCoverage(),
  }));

  // Protection metrics adapter: exposes the latest lab-scrubber-measured
  // detection/mitigation timing in the exact shape the protection pull-connector
  // (PROTECTION_METRICS_URL → PollProtectionProvider) expects. Point
  // PROTECTION_METRICS_URL at this route so a campaign's WRS uses the lab's REAL
  // measured TTD/TTM (source 'wedos-lab-scrubber') instead of a conservative
  // estimate. Class-C lab measurements are not campaign-scoped, so the pull
  // connector's query window (campaignId/target/from/to) is ignored and the most
  // recent completed lab measurement is returned. When no lab mitigation has been
  // measured yet, it 404s so the connector cleanly falls back to the estimate —
  // never a fabricated zero.
  //
  // No user guard: the connector GETs this unauthenticated over loopback with a
  // fixed marker header. We require that header and rely on the loopback-only
  // bind; the response only ever carries aggregate lab timing, never secrets.
  app.get('/api/protection/lab-metrics', async (req, reply) => {
    if (req.headers['x-wedos-shieldtest'] !== 'protection-query') {
      return reply.code(404).send({ error: 'not found' });
    }
    const runs = await store.listBenchRuns();
    const latest = runs.find(
      (r) =>
        r.status === 'COMPLETED' &&
        r.verdict?.class === 'C' &&
        r.verdict.mitigation != null &&
        typeof r.verdict.mitigation.detectionSec === 'number',
    );
    const m = latest?.verdict?.mitigation;
    if (!m || typeof m.detectionSec !== 'number') {
      return reply.code(404).send({ error: 'no lab measurement available' });
    }
    return {
      detectionTimeSec: m.detectionSec,
      // Mitigation starts at detection when the scrubber engages (mirrors the
      // lab scrubber's own /protection contract); 0 when it never engaged.
      mitigationTimeSec: m.engaged ? m.detectionSec : 0,
      source: 'wedos-lab-scrubber',
      strategy: m.strategy,
      scenario: latest?.verdict?.scenario,
      measuredAt: latest?.verdict?.generatedAt,
    };
  });

  app.post('/api/bench/coverage', { preHandler: guard('bench:attest') }, async (req, reply) => {
    let entry: Omit<BenchCoverage, 'id' | 'at'>;
    try {
      entry = parseCoverageInput(req.body, req.authUser?.email ?? 'dev');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const record: BenchCoverage = { ...entry, id: randomUUID(), at: new Date().toISOString() };
    await store.saveBenchCoverage(record);
    await audit(
      req,
      'bench.coverage',
      undefined,
      `${record.method} · ${record.vector} → ${record.outcome ?? 'recorded'} (${record.source})`,
    );
    return reply.code(201).send(record);
  });

  // Structured attestation checklists (BCP38/uRPF, GRE-drop, fragment limits)
  // for the out-of-model vectors. Read the catalogue, then submit a completed
  // checklist; the bench derives a deterministic ATTESTED coverage record. No
  // traffic is generated — this records edge controls that are already enforced.
  app.get('/api/bench/attestations', { preHandler: guard('bench:read') }, async () => ({
    checklists: ATTESTATION_CHECKLISTS,
  }));

  app.post('/api/bench/attestations', { preHandler: guard('bench:attest') }, async (req, reply) => {
    let entry: Omit<BenchCoverage, 'id' | 'at'>;
    try {
      entry = parseAttestationInput(req.body, req.authUser?.email ?? 'dev');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const record: BenchCoverage = { ...entry, id: randomUUID(), at: new Date().toISOString() };
    await store.saveBenchCoverage(record);
    await audit(
      req,
      'bench.coverage',
      undefined,
      `ATTESTED · ${record.vector} → ${record.outcome ?? 'recorded'} (${record.source})`,
    );
    return reply.code(201).send(record);
  });

  // Bulk import of external (network-team) L3/4 bench verdicts as read-only
  // INGESTED_EXTERNAL coverage. Accepts JSON rows or CSV; nothing is emitted.
  // Invalid rows are reported, not silently dropped.
  app.post(
    '/api/bench/coverage/import',
    { preHandler: guard('bench:attest') },
    async (req, reply) => {
      const b = (req.body ?? {}) as { format?: string; data?: unknown; source?: string };
      const format = b.format === 'csv' ? 'csv' : 'json';
      let parsed;
      try {
        parsed = parseIngestBatch(
          b.data,
          format,
          req.authUser?.email ?? 'dev',
          b.source ? String(b.source) : undefined,
        );
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const saved: BenchCoverage[] = [];
      for (const entry of parsed.entries) {
        const record: BenchCoverage = { ...entry, id: randomUUID(), at: new Date().toISOString() };
        await store.saveBenchCoverage(record);
        saved.push(record);
      }
      if (saved.length > 0) {
        const vectors = [...new Set(saved.map((r) => r.vector))].join(', ');
        await audit(
          req,
          'bench.coverage',
          undefined,
          `INGESTED_EXTERNAL · imported ${saved.length} verdict(s) [${vectors}]`,
        );
      }
      return reply
        .code(201)
        .send({ imported: saved.length, errors: parsed.errors, records: saved });
    },
  );

  // Reachable during a forced password change (unlike guarded routes) so the UI
  // can learn it must send the operator to the change-password screen.
  app.get('/api/auth/me', async (req, reply) => {
    if (!auth.enabled) return { email: null, role: null, authRequired: false };
    const r = await resolveIdentity(req);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    req.authUser = r.id;
    return { email: r.id.email, role: r.id.role, mustChangePassword: r.mustChange };
  });

  // --- User management (officer only; env users are immutable) ---------------
  const envUsers = (): { email: string; role: Role }[] =>
    [...auth.users.values()].map((u) => ({ email: u.email, role: u.role }));
  const envEmailSet = (): Set<string> => new Set([...auth.users.keys()]);
  /** Env-defined users merged with runtime store users (env wins on collision). */
  const currentUsers = async () => {
    const stored = (await store.listUsers()).map((u) => ({
      email: u.email,
      role: u.role,
      status: u.status ?? 'active',
      mustChangePassword: u.mustChangePassword ?? false,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
    return combineUsers(envUsers(), stored);
  };

  app.get('/api/users', { preHandler: guard('user:manage') }, async (_req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    return currentUsers();
  });

  app.post('/api/users', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const body = req.body as { email?: string; role?: string; password?: string };
      const current = await currentUsers();
      const { email, role } = assertUpsert(
        { email: body.email ?? '', role: body.role ?? '', password: body.password ?? '' },
        { envEmails: envEmailSet(), current, actorEmail: req.authUser?.email ?? '' },
      );
      // Create-only: never silently overwrite an existing account's role/password.
      // Role changes go through PATCH; a re-create is an explicit 409.
      if (current.some((u) => u.email.toLowerCase() === email)) {
        return reply
          .code(409)
          .send({ error: `User ${email} already exists — use PATCH to change their role.` });
      }
      // Admin-set password is temporary: the user must change it at first login.
      await store.saveUser({
        email,
        role,
        passwordHash: hashPassword(body.password ?? ''),
        status: 'active',
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
        tokenVersion: 0,
      });
      await audit(req, 'user.upsert', undefined, `${email} → ${role} (create)`);
      return reply.code(201).send({ email, role, source: 'store', mustChangePassword: true });
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.patch('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const raw = decodeURIComponent((req.params as { email: string }).email);
      const body = req.body as { role?: string; status?: string };
      if (body.role == null && body.status == null) {
        return reply.code(400).send({ error: 'nothing to change (role or status required)' });
      }
      const ctx = {
        envEmails: envEmailSet(),
        current: await currentUsers(),
        actorEmail: req.authUser?.email ?? '',
      };
      // Validate against the combined view FIRST (env-immutable, self, existence)
      // so those surface as 400s before we ever touch the store.
      const nextRole = body.role != null ? assertRoleChange(raw, body.role, ctx).role : undefined;
      const nextStatus =
        body.status != null ? assertStatusChange(raw, body.status, ctx).status : undefined;
      const existing = await store.getUser(raw.toLowerCase());
      if (!existing) return reply.code(404).send({ error: 'user not found' });
      let updated: User = existing;
      let revoke = false;

      if (nextRole !== undefined) {
        updated = { ...updated, role: nextRole };
        // A role change takes effect immediately: revoke outstanding tokens.
        revoke = true;
        await audit(req, 'user.upsert', undefined, `${existing.email} → ${nextRole} (role change)`);
      }
      if (nextStatus !== undefined) {
        updated = { ...updated, status: nextStatus };
        // Deactivation must cut access now, not at token exp.
        if (nextStatus === 'disabled') revoke = true;
        await audit(req, 'user.status', undefined, `${existing.email} → ${nextStatus}`);
      }
      if (revoke) updated = { ...updated, tokenVersion: (existing.tokenVersion ?? 0) + 1 };
      await store.saveUser(updated);
      return { email: updated.email, role: updated.role, status: updated.status, source: 'store' };
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  // Admin password reset — sets a temporary password the user must change at
  // next login, and revokes their outstanding sessions.
  app.post(
    '/api/users/:email/password',
    { preHandler: guard('user:manage') },
    async (req, reply) => {
      if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
      try {
        const raw = decodeURIComponent((req.params as { email: string }).email);
        const body = req.body as { password?: string };
        const { email } = assertReset(raw, body.password ?? '', {
          envEmails: envEmailSet(),
          current: await currentUsers(),
          actorEmail: req.authUser?.email ?? '',
        });
        const existing = await store.getUser(email);
        if (!existing) return reply.code(404).send({ error: 'user not found' });
        await store.saveUser({
          ...existing,
          passwordHash: hashPassword(body.password ?? ''),
          mustChangePassword: true,
          tokenVersion: (existing.tokenVersion ?? 0) + 1,
        });
        await audit(req, 'password.reset', undefined, email);
        return { email, source: 'store', mustChangePassword: true };
      } catch (err) {
        if (err instanceof UserError) return reply.code(400).send({ error: err.message });
        return fail(err, reply);
      }
    },
  );

  app.delete('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const raw = decodeURIComponent((req.params as { email: string }).email);
      const current = await currentUsers();
      const email = assertDelete(raw, {
        envEmails: envEmailSet(),
        current,
        actorEmail: req.authUser?.email ?? '',
      });
      await store.deleteUser(email);
      await audit(req, 'user.delete', undefined, email);
      return { deleted: email };
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.get('/api/campaigns', { preHandler: guard('campaign:read') }, async () =>
    store.listCampaigns(),
  );

  app.get('/api/campaigns/:id', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const c = await store.getCampaign((req.params as { id: string }).id);
    return c ?? reply.code(404).send({ error: 'campaign not found' });
  });

  app.post('/api/campaigns', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const input = req.body as CampaignInput;
      if (req.authUser) input.createdBy = req.authUser.email;
      const campaign = createCampaign(input, allowedTargets, agentChoices(), effectiveCaps);
      await store.saveCampaign(campaign);
      await audit(req, 'campaign.create', campaign.id, `${campaign.name} → ${campaign.target}`);
      return reply.code(201).send(campaign);
    } catch (err) {
      return fail(err, reply);
    }
  });

  // Assessment playbooks: curated + user-defined sequences of bounded campaigns.
  app.get('/api/playbooks', { preHandler: guard('campaign:read') }, async () => {
    const curated = PLAYBOOKS.map((p) => ({ ...p, custom: false }));
    const custom = await store.listPlaybooks();
    return [...curated, ...custom];
  });

  app.post('/api/playbooks', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const pb = validatePlaybookInput(req.body, effectiveCaps);
      await store.savePlaybook(pb);
      await audit(req, 'playbook.upsert', undefined, `${pb.name} (${pb.steps.length} steps)`);
      return reply.code(201).send(pb);
    } catch (err) {
      if (err instanceof PlaybookError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.delete('/api/playbooks/:id', { preHandler: guard('campaign:create') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!id.startsWith('custom-')) {
      return reply.code(400).send({ error: 'only custom playbooks can be deleted' });
    }
    const existing = await store.getPlaybook(id);
    if (!existing) return reply.code(404).send({ error: 'playbook not found' });
    await store.deletePlaybook(id);
    await audit(req, 'playbook.delete', undefined, existing.name);
    return { deleted: id };
  });

  app.post(
    '/api/playbooks/:id/instantiate',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const pb = getPlaybook(id) ?? (await store.getPlaybook(id));
      if (!pb) return reply.code(404).send({ error: 'playbook not found' });
      const body = req.body as { target?: string; probeUrl?: string; recurrenceMin?: number };
      if (!body.target) return reply.code(400).send({ error: 'target is required' });
      try {
        const engines = (await describeAgents()).map((a) => ({ id: a.id, available: a.available }));
        // Systematic recon: seed the suite's endpoints from the target's real
        // published surface so path-based lines can't flood non-existent paths
        // (404). Best-effort and non-blocking (see reconSeed).
        const seed = await reconSeed(body.target, body.probeUrl || body.target);
        const inputs = buildSuiteCampaigns(
          pb,
          {
            target: body.target,
            probeUrl: body.probeUrl || body.target,
            createdBy: req.authUser?.email ?? 'dev',
            recurrenceMin: body.recurrenceMin,
            recon: seed.surface,
          },
          engines,
        );
        const created: Campaign[] = [];
        for (const input of inputs) {
          const campaign = createCampaign(input, allowedTargets, agentChoices(), effectiveCaps);
          await store.saveCampaign(campaign);
          created.push(campaign);
        }
        await audit(
          req,
          'campaign.create',
          undefined,
          `playbook "${pb.name}" → ${created.length} campaigns (suite ${created[0]?.suiteId}` +
            `${seed.summary.seeded ? ', recon-seeded' : ''})`,
        );
        return reply
          .code(201)
          .send({ suiteId: created[0]?.suiteId, campaigns: created, recon: seed.summary });
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Compose several templates into ONE suite (their steps concatenated in the
  // given order under a single suiteId). Behaves like any other suite from
  // there on: sequencer, aggregate WRS, one assessment report.
  app.post('/api/suites/compose', { preHandler: guard('campaign:create') }, async (req, reply) => {
    const body = req.body as {
      playbookIds?: string[];
      name?: string;
      target?: string;
      probeUrl?: string;
      recurrenceMin?: number;
    };
    const ids = Array.isArray(body.playbookIds) ? body.playbookIds : [];
    if (ids.length < 2) {
      return reply
        .code(400)
        .send({ error: 'playbookIds must list at least two templates to compose' });
    }
    if (!body.target) return reply.code(400).send({ error: 'target is required' });
    const playbooks: Playbook[] = [];
    for (const id of ids) {
      const pb = getPlaybook(id) ?? (await store.getPlaybook(id));
      if (!pb) return reply.code(404).send({ error: `playbook not found: ${id}` });
      playbooks.push(pb);
    }
    const totalSteps = playbooks.reduce((n, p) => n + p.steps.length, 0);
    if (totalSteps > MAX_COMPOSITE_STEPS) {
      return reply.code(400).send({
        error: `composed suite has ${totalSteps} steps; the maximum is ${MAX_COMPOSITE_STEPS} — remove a template`,
      });
    }
    const name =
      body.name?.trim() || `Composite — ${playbooks.map((p) => p.name).join(' + ')}`.slice(0, 120);
    try {
      const engines = (await describeAgents()).map((a) => ({ id: a.id, available: a.available }));
      // Systematic recon-seeding (same as single-playbook instantiation).
      const seed = await reconSeed(body.target, body.probeUrl || body.target);
      const inputs = buildCompositeSuite(
        playbooks,
        name,
        {
          target: body.target,
          probeUrl: body.probeUrl || body.target,
          createdBy: req.authUser?.email ?? 'dev',
          recurrenceMin: body.recurrenceMin,
          recon: seed.surface,
        },
        engines,
      );
      const created: Campaign[] = [];
      for (const input of inputs) {
        const campaign = createCampaign(input, allowedTargets, agentChoices(), effectiveCaps);
        await store.saveCampaign(campaign);
        created.push(campaign);
      }
      await audit(
        req,
        'campaign.create',
        undefined,
        `composite "${name}" ← ${playbooks.length} templates → ${created.length} campaigns ` +
          `(suite ${created[0]?.suiteId}${seed.summary.seeded ? ', recon-seeded' : ''})`,
      );
      return reply
        .code(201)
        .send({ suiteId: created[0]?.suiteId, campaigns: created, recon: seed.summary });
    } catch (err) {
      return fail(err, reply);
    }
  });

  app.post(
    '/api/campaigns/:id/approval',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      try {
        const c = await store.getCampaign((req.params as { id: string }).id);
        if (!c) return reply.code(404).send({ error: 'campaign not found' });
        const body = req.body as {
          approvedBy?: string;
          decision: 'APPROVED' | 'REJECTED';
          reason?: string;
        };
        const approvedBy = req.authUser?.email ?? body.approvedBy ?? '';
        const updated = approveCampaign(c, approvedBy, body.decision, body.reason);
        await store.saveCampaign(updated);
        await audit(
          req,
          body.decision === 'APPROVED' ? 'campaign.approve' : 'campaign.reject',
          c.id,
          body.reason,
        );
        return updated;
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Mandatory CISO sign-off (dual control). A CISO co-signs an officer-approved
  // campaign; separation of duties (author ≠ officer ≠ CISO) is enforced.
  app.post(
    '/api/campaigns/:id/ciso-approval',
    { preHandler: guard('campaign:ciso-approve') },
    async (req, reply) => {
      try {
        const c = await store.getCampaign((req.params as { id: string }).id);
        if (!c) return reply.code(404).send({ error: 'campaign not found' });
        const body = (req.body ?? {}) as { cisoBy?: string };
        const cisoBy = req.authUser?.email ?? body.cisoBy ?? '';
        const updated = cisoApproveCampaign(c, cisoBy);
        await store.saveCampaign(updated);
        await audit(req, 'campaign.ciso_approve', c.id, `CISO sign-off by ${cisoBy}`);
        return updated;
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Archive / un-archive a campaign (organisational housekeeping — hides it from
  // the default list without touching its run history, reports or audit).
  app.post(
    '/api/campaigns/:id/archive',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      try {
        const c = await store.getCampaign((req.params as { id: string }).id);
        if (!c) return reply.code(404).send({ error: 'campaign not found' });
        const archived = ((req.body ?? {}) as { archived?: boolean }).archived !== false;
        const updated = setArchived(c, archived);
        await store.saveCampaign(updated);
        await audit(req, 'campaign.archive', c.id, archived ? 'archived' : 'unarchived');
        return updated;
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Admin purge (officer only): permanently delete test campaigns and their
  // runs. 'settled' removes only terminal campaigns; 'all' also removes pending/
  // approved ones and stops (kill-switches) any RUNNING campaign — but never
  // DELETES a running one (its engine is live), so re-purge after it settles.
  // The tamper-evident audit log is never touched.
  const TERMINAL_STATUSES = [
    'COMPLETED',
    'KILLED_AUTO',
    'KILLED_MANUAL',
    'CANCELLED',
    'REJECTED',
  ] as const;
  app.post('/api/campaigns/purge', { preHandler: guard('user:manage') }, async (req, reply) => {
    try {
      const scope = ((req.body ?? {}) as { scope?: string }).scope === 'all' ? 'all' : 'settled';
      const campaigns = await store.listCampaigns();
      let killed = 0;
      if (scope === 'all') {
        for (const c of campaigns) {
          if (c.status === 'RUNNING') {
            kills.get(c.id)?.trigger('KILLED_MANUAL');
            killed++;
          }
        }
      }
      const deletable =
        scope === 'all'
          ? [...TERMINAL_STATUSES, 'PENDING_APPROVAL', 'APPROVED']
          : [...TERMINAL_STATUSES];
      const ids = campaigns.filter((c) => deletable.includes(c.status)).map((c) => c.id);
      const deleted = await store.deleteCampaigns(ids);
      await audit(
        req,
        'campaign.purge',
        undefined,
        `scope=${scope} deleted=${deleted} killed=${killed}`,
      );
      return { deleted, killedRunning: killed, scope };
    } catch (err) {
      return fail(err, reply);
    }
  });

  // Archive / un-archive a whole assessment suite in one call (every member).
  app.post(
    '/api/suites/:id/archive',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const archived = ((req.body ?? {}) as { archived?: boolean }).archived !== false;
      const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
      if (members.length === 0) return reply.code(404).send({ error: 'suite not found' });
      let changed = 0;
      for (const m of members) {
        try {
          const updated = setArchived(m, archived);
          if (updated !== m) {
            await store.saveCampaign(updated);
            changed += 1;
          }
        } catch {
          // Skip a member that can't be archived (e.g. a step still running) —
          // the rest of the suite is still archived.
        }
      }
      await audit(
        req,
        'campaign.archive',
        undefined,
        `suite ${suiteId} ${archived ? 'archived' : 'unarchived'} · ${changed}/${members.length} step(s)`,
      );
      return reply.send({ suiteId, archived, changed, total: members.length });
    },
  );

  app.post(
    '/api/campaigns/:id/execute',
    { preHandler: guard('campaign:execute') },
    async (req, reply) => {
      const c = await store.getCampaign((req.params as { id: string }).id);
      if (!c) return reply.code(404).send({ error: 'campaign not found' });
      // A step whose suite sequence is running is driven by the sequencer — a
      // manual run here would put two steps in flight at once. Refuse it.
      if (c.suiteId && suiteRuns.has(c.suiteId)) {
        return reply.code(409).send({
          error:
            'This campaign is part of a running assessment sequence — pause or cancel the ' +
            'sequence before running a step manually.',
        });
      }
      try {
        assertExecutable(c, { requireCiso: requireCisoApproval });
      } catch (err) {
        return fail(err, reply);
      }
      // Separation of duties (extended): the officer who approved a campaign may
      // not also execute it. Author≠approver is enforced at approval; this closes
      // the remaining concentration (approver≠executor). Only meaningful when
      // auth identifies the actor.
      const executor = req.authUser?.email;
      if (executor && c.approvedBy && executor.toLowerCase() === c.approvedBy.toLowerCase()) {
        return reply.code(403).send({
          error: 'Separation of duties: the approver of a campaign cannot also execute it.',
        });
      }
      if (kills.count() >= maxConcurrentRuns) {
        return reply.code(429).send({
          error: `Too many concurrent runs (max ${maxConcurrentRuns}). Try again once one finishes.`,
        });
      }
      try {
        const run = await runCampaign(c, req.authUser?.email ?? 'dev');
        return reply.code(201).send(run);
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Run every step of a suite in order (governed one-click). Fire-and-forget:
  // the sequence runs in the background and advances through auto-kills. Poll
  // GET /api/suites/:id (or the campaign list) to watch step statuses advance.
  app.post('/api/suites/:id/run', { preHandler: guard('campaign:approve') }, async (req, reply) => {
    const suiteId = (req.params as { id: string }).id;
    const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
    if (members.length === 0) return reply.code(404).send({ error: 'suite not found' });
    // Reserve the slot synchronously here — BEFORE the audit await below — so two
    // near-simultaneous submits can't both pass the guard and start two
    // sequences (which would run two steps at once).
    const ctrl = reserveSuiteRun(suiteId);
    if (!ctrl) {
      return reply.code(409).send({ error: 'this suite sequence is already running' });
    }
    ctrl.total = members.length;
    const actor = req.authUser?.email ?? 'dev';
    await audit(req, 'suite.run', undefined, `sequence start · ${members.length} steps`);
    // Do not await — the whole sequence can run for many minutes.
    void runSuiteSequence(suiteId, actor, ctrl);
    return reply.code(202).send({ suiteId, steps: members.length, started: true });
  });

  // Live state of the in-flight suite sequences (for the UI's pause/cancel
  // controls). Only sequences currently running appear here.
  app.get('/api/suites/sequences', { preHandler: guard('campaign:read') }, async () => {
    const sequences: Record<
      string,
      {
        paused: boolean;
        current?: string;
        started: number;
        total: number;
        autoPaused?: boolean;
        downSkips: number;
      }
    > = {};
    for (const [sid, ctrl] of suiteRuns) {
      sequences[sid] = {
        paused: ctrl.paused,
        current: ctrl.current,
        started: ctrl.started,
        total: ctrl.total,
        autoPaused: ctrl.autoPaused,
        downSkips: ctrl.downSkips,
      };
    }
    return { sequences };
  });

  // Pause a running sequence: the current step finishes, the next does not
  // start until resumed. No effect on a step already in flight.
  app.post(
    '/api/suites/:id/pause',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const ctrl = suiteRuns.get(suiteId);
      if (!ctrl) return reply.code(404).send({ error: 'no running sequence for this suite' });
      ctrl.paused = true;
      await audit(req, 'suite.pause', undefined, `sequence paused · ${suiteId}`);
      return reply.send({ suiteId, paused: true });
    },
  );

  // Resume a paused sequence.
  app.post(
    '/api/suites/:id/resume',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const ctrl = suiteRuns.get(suiteId);
      if (!ctrl) return reply.code(404).send({ error: 'no running sequence for this suite' });
      ctrl.paused = false;
      // Resume clears the auto-pause state and the down-skip counter, so the
      // gate re-evaluates the target fresh rather than immediately re-pausing.
      ctrl.autoPaused = false;
      ctrl.downSkips = 0;
      await audit(req, 'suite.resume', undefined, `sequence resumed · ${suiteId}`);
      return reply.send({ suiteId, paused: false });
    },
  );

  // Cancel a running sequence: stop before the next step and kill the step in
  // flight (its kill switch fires — a KILLED_MANUAL terminal state). Steps not
  // yet started are left as-is (approved but not run).
  app.post(
    '/api/suites/:id/cancel',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const ctrl = suiteRuns.get(suiteId);
      if (!ctrl) return reply.code(404).send({ error: 'no running sequence for this suite' });
      ctrl.cancelled = true;
      ctrl.paused = false; // release the pause gate so the loop can break out
      const current = ctrl.current;
      if (current) kills.get(current)?.trigger('KILLED_MANUAL');
      // Close the scenario cleanly: cancel the steps that will now never run
      // (pending or approved), so no orphan steps linger after the cancel. The
      // step in flight (current) is left to its kill switch above.
      let cancelledSteps = 0;
      const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
      for (const m of members) {
        if (m.id === current) continue;
        if (m.status === 'PENDING_APPROVAL' || m.status === 'APPROVED') {
          await store.saveCampaign(cancelCampaign(m, `suite ${suiteId} cancelled`));
          cancelledSteps += 1;
        }
      }
      await audit(
        req,
        'suite.cancel',
        current,
        `sequence cancelled · ${suiteId}${current ? ` · killed step in flight` : ''}` +
          ` · ${cancelledSteps} step(s) cancelled`,
      );
      return reply.send({
        suiteId,
        cancelled: true,
        killedCurrent: Boolean(current),
        cancelledSteps,
      });
    },
  );

  app.get('/api/campaigns/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!readTokenAllowed(req)) return reply.code(401).send({ error: 'authentication required' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const TERMINAL: CampaignStatus[] = [
      'COMPLETED',
      'KILLED_AUTO',
      'KILLED_MANUAL',
      'REJECTED',
      'CANCELLED',
    ];
    // Initial frame: current progress if any, else "waiting" (never "done" on
    // connect — the UI closes the stream on "done", so a premature one would
    // strand the progress view).
    send(liveProgress.get(id) ?? { status: 'waiting' });
    // Only close when the campaign has actually reached a terminal state. While
    // it is still RUNNING/APPROVED/PENDING (e.g. the baseline capture before
    // load, or a suite step awaiting its turn) there may be no live record yet —
    // emit a "waiting" keepalive instead of a premature "done".
    const timer = setInterval(async () => {
      const p = liveProgress.get(id);
      if (p) return send(p);
      const c = await store.getCampaign(id);
      if (!c || TERMINAL.includes(c.status)) {
        send({ status: 'done' });
        clearInterval(timer);
        res.end();
      } else {
        send({ status: 'waiting' });
      }
    }, 1000);
    req.raw.on('close', () => clearInterval(timer));
  });

  app.post(
    '/api/campaigns/:id/kill',
    { preHandler: guard('campaign:kill') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const kill = kills.get(id);
      if (kill) {
        kill.trigger('KILLED_MANUAL');
        await audit(req, 'campaign.kill', id);
        return { status: 'KILLED_MANUAL' };
      }
      // No live run is attached to this campaign. If the store still marks it
      // RUNNING, that status is STALE — a previous process died mid-run, or a
      // run settled without its status being updated. There is no in-flight load
      // to signal, yet the operator is stuck watching a "RUNNING" they cannot
      // stop, and a bare 404 leaves a server restart as the only escape. Instead
      // force-reconcile just this campaign to APPROVED (re-runnable) on demand —
      // the same reset reconcileOrphanedRuns applies at startup.
      const c = await store.getCampaign(id);
      if (c?.status === 'RUNNING') {
        await store.saveCampaign({
          ...c,
          status: 'APPROVED',
          statusDetail:
            'Force-stopped from the console: no live run was attached (stale RUNNING) — reset to re-runnable.',
        });
        await audit(req, 'campaign.kill', id, 'force-reset stale RUNNING (no live run attached)');
        return { status: 'RESET_STALE' };
      }
      return reply.code(404).send({ error: 'no run in progress' });
    },
  );

  // Cancel an unrun campaign (pending or approved) before it executes. Terminal
  // CANCELLED — for a run in flight, use the kill switch instead.
  app.post(
    '/api/campaigns/:id/cancel',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const c = await store.getCampaign((req.params as { id: string }).id);
      if (!c) return reply.code(404).send({ error: 'campaign not found' });
      const reason = (req.body as { reason?: string } | undefined)?.reason;
      try {
        const cancelled = cancelCampaign(c, reason);
        await store.saveCampaign(cancelled);
        await audit(req, 'campaign.cancel', c.id, cancelled.statusDetail);
        return cancelled;
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  registerReadRoutes(app, { store, guard, readTokenAllowed, prometheusUrl: opts.prometheusUrl });

  return { app, runCampaign };
}
