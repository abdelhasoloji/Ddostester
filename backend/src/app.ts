import { parameterBudget } from './modules/campaigns/parameter-budget.js';
import {
  parameterInput,
  parameterRevision,
  editableParameters,
} from './modules/campaigns/parameters.js';
import { DrsBaselineError } from './modules/drs/baseline.js';
import { transition as transitionDrs, finalize as finalizeDrs } from './modules/drs/workflow.js';
import { runAttachment } from './modules/drs/attachments.js';
import { assessDrs } from './modules/drs/scoring.js';
import { registerDrsRoutes } from './routes/drs-routes.js';
import { drsReport } from './modules/drs/report.js';
import { drsReference } from './modules/drs/reference.js';
import { deriveEnvelope, levelReachability, parseQuantity } from './modules/drs/capacity.js';
import { parseCalibration, CalibrationError } from './modules/drs/calibration.js';
import { drsWorkflow, drsCatalog } from './modules/drs/catalog.js';
import { registerFleetMissionRoutes } from './routes/fleet-mission-routes.js';
import {
  auditedStore,
  mutationActor,
  mutationSessionVersion,
  mutationSessionExpiresAt,
} from './store/audited.js';
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
import { computeAbsorption, splitFailures } from './modules/reports/absorption.js';
import { scenarioMeanRps } from './modules/campaigns/calibration.js';
import {
  fleetCpuContention,
  remoteProbeQualityReasons,
  computeConfidence,
  EVENT_LOOP_LAG_GUARD_MS,
} from './modules/reports/confidence.js';
import { assessVector } from './modules/reports/assessment.js';
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
import {
  waitForTargetAvailable,
  type RecoveryOptions,
  type RecoveryResult,
} from './modules/campaigns/recovery.js';
import { reArmRecurring } from './modules/campaigns/scheduler.js';
import type { CampaignRun } from './modules/campaigns/runner.js';
import type {
  Campaign,
  CampaignInput,
  CampaignStatus,
  ReconPostureSnapshot,
} from './modules/campaigns/model.js';
import {
  HARD_CAPS,
  MAX_COMPOSITE_STEPS,
  BUILTIN_RPS_CEILING,
  BUILTIN_CONCURRENCY_CEILING,
  clampToCeiling,
  withinCeiling,
  remoteProbeFromEnv,
} from './config/limits.js';
import {
  highRateEngineUpgrade,
  builtinUnderDeliveryReason,
} from './modules/campaigns/engine-route.js';
import type { HardCaps } from './config/limits.js';
import {
  BENCH_SCENARIOS,
  CLASS_C_LADDERS,
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
import { registerAssistantRoutes } from './routes/assistant-routes.js';
import { assistantConfigFromEnv } from './modules/assistant/provider.js';
import type { AssistantTokenBudget } from './modules/assistant/token-budget.js';
import {
  assistantTargetOrigin,
  assistantMeasurementSummary,
  assistantLatestRun,
} from './modules/assistant/context.js';
import { runpodConfigFromEnv, podProxyEndpoint } from './modules/assistant/runpod.js';
import { registerTargetRoutes } from './routes/target-routes.js';
import { authorizedHosts } from './modules/targets/model.js';
import { buildWrsHistory } from './modules/wrs/history.js';
import type { AuditEntry } from './modules/audit/model.js';
import type { LoadProgress } from './engine/loadTest.js';
import { loginAsync as login, payloadFromRequest } from './auth/guard.js';
import { configureAccounts } from './auth/single-user.js';
import { registerUserRoutes } from './routes/user-routes.js';
import { registerFleetRoutes } from './routes/fleet-routes.js';
import { signJwt, verifyJwt } from './auth/jwt.js';
import { hashPassword, hashPasswordAsync, verifyPasswordAsync } from './auth/passwords.js';
import { passwordProblem } from './auth/password-policy.js';
import { can, canonicalRole, permissionsFor, ACCESS_CONTRACT_VERSION } from './auth/rbac.js';
import type { Permission, Role } from './auth/rbac.js';
import { BuiltinHttpAgent } from './agents/builtin.js';
import { createAgent, describeAgents, agentChoices, resolveCampaignAgent } from './agents/index.js';
import { runRecon } from './modules/recon/fetch.js';
import { assertDestination } from './util/destination.js';
import { reconPostureSnapshot } from './modules/recon/recon.js';
import { recommendActions } from './modules/recon/actions.js';
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
import { deriveAlerts } from './modules/alerts/derive.js';

export interface BuildOptions {
  assistantTokenBudget?: AssistantTokenBudget;
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
   * Auto-route a high-rate simple flood off the built-in engine (whose measured
   * ceiling is `BUILTIN_RPS_CEILING`) onto an available out-of-process engine so
   * it delivers the configured rate. Default true; set false to pin every run to
   * its chosen engine (e.g. for deterministic tests).
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
   * Grafana base URL for the "Open in Grafana" deep-links (the run dashboard
   * `shieldtest-run`). Absent = the UI hides the Grafana links and shows only the
   * app-native panels. Grafana is loopback on the monitoring host, so in
   * production this points at a tunnel/proxy the operator's browser can reach.
   */
  grafanaUrl?: string;
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
  const { auth, allowedTargets } = opts;
  const store = auditedStore(opts.store);
  const singleUser = auth.userMode === 'single';
  if (singleUser && opts.requireCisoApproval) {
    throw new Error('Single-user mode is incompatible with REQUIRE_CISO_APPROVAL.');
  }
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

  await configureAccounts(store, auth);
  const accountPolicy = await store.getAccountPolicy();

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
  const readStreams = new Set<FastifyReply['raw']>();
  app.addHook('preClose', async () => {
    for (const stream of readStreams) stream.end();
  });
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function (req, reply) {
      return mutationActor.run(req.authUser?.email ?? 'system', () =>
        mutationSessionVersion.run(
          req.authUser ? (payloadFromRequest(auth, req)?.ver ?? 0) : undefined,
          () =>
            mutationSessionExpiresAt.run(
              req.authUser ? (payloadFromRequest(auth, req)?.exp ?? 0) * 1000 : undefined,
              () => handler.call(this, req, reply),
            ),
        ),
      );
    };
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
    // Defense in depth: also assert HSTS in-app (browsers only honour it over
    // HTTPS) so a direct-to-Node deploy isn't reliant on the proxy for it. The
    // TLS-terminating proxy still sets its own; this covers the proxy-less path.
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
    // Canonicalise the role from EVERY source (token payload or store) so a
    // pre-overhaul `officer` id resolves to `admin` on the authorization path —
    // this function feeds `guard()`/`req.authUser`, so a stale id here would
    // deny a legacy user everything (MATRIX has no `officer`). identityFromRequest
    // canonicalises too; this is the store-aware twin that must not drift.
    if (singleUser && email.startsWith('share:'))
      return { ok: false, code: 401, error: 'share tokens are disabled' };
    if (email.startsWith('share:')) {
      return {
        ok: true,
        id: {
          email,
          role: canonicalRole(payload.role) ?? (payload.role as Role),
        },
        mustChange: false,
      };
    }
    if (auth.users.has(email.toLowerCase())) {
      return {
        ok: true,
        id: {
          email,
          role: auth.users.get(email.toLowerCase())!.role,
        },
        mustChange: false,
      };
    }
    const su = await store.getUser(email.toLowerCase());
    if (!su)
      return {
        ok: false,
        code: 401,
        error: 'account no longer exists — sign in again',
      };
    if ((su.status ?? 'active') === 'disabled') {
      return { ok: false, code: 401, error: 'account disabled' };
    }
    if ((payload.ver ?? 0) !== (su.tokenVersion ?? 0)) {
      return { ok: false, code: 401, error: 'session expired — sign in again' };
    }
    return {
      ok: true,
      id: { email: su.email, role: canonicalRole(su.role) ?? su.role },
      mustChange: !!su.mustChangePassword,
    };
  }

  const adminConfirmation = (req: FastifyRequest): boolean =>
    singleUser && req.authUser?.role === 'admin';
  const accessContract = (role: Role) => ({
    capabilities: permissionsFor(role),
    contractVersion: ACCESS_CONTRACT_VERSION,
    userMode: auth.userMode ?? 'team',
    primaryAdminEmail: accountPolicy?.primaryAdminEmail,
    approvalPolicy:
      singleUser && role === 'admin' ? ('confirmation' as const) : ('dual_control' as const),
  });

  function guard(perm: Permission) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!auth.enabled) return;
      const identityRequest =
        perm === 'campaign:read' &&
        req.method === 'GET' &&
        !req.headers.authorization &&
        readCookie(req)
          ? ({ headers: { authorization: `Bearer ${readCookie(req)}` } } as FastifyRequest)
          : req;
      const r = await resolveIdentity(identityRequest);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      if (
        accountPolicy &&
        r.id.role === 'admin' &&
        r.id.email.toLowerCase() !== accountPolicy.primaryAdminEmail
      )
        return reply.code(403).send({ error: 'Only the owner has administrator permissions.' });
      req.authUser = r.id;
      if (r.mustChange) {
        return reply.code(403).send({
          error: 'password change required',
          code: 'password_change_required',
        });
      }
      if (!can(r.id.role, perm, auth.userMode)) {
        return reply.code(403).send({ error: `missing ${perm} permission` });
      }
    };
  }

  const readCookie = (req: FastifyRequest): string | undefined => {
    const value = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('shieldtest_read='))
      ?.slice('shieldtest_read='.length);
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  const setReadCookie = (
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    clear = false,
  ) => {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
    const expiry = clear ? undefined : verifyJwt(token, auth.secret)?.exp;
    const maxAge = expiry === undefined ? 0 : Math.max(0, expiry - Math.floor(Date.now() / 1000));
    reply.header(
      'set-cookie',
      `shieldtest_read=${clear ? '' : encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${loopback && req.protocol === 'http' ? '' : '; Secure'}`,
    );
  };
  // Set/refresh the browser read cookie after successful session operations.
  app.addHook('onSend', async (req, reply, payload) => {
    if (
      reply.statusCode < 400 &&
      ['/api/auth/login', '/api/auth/password', '/api/auth/sessions/revoke'].includes(
        req.routeOptions.url ?? '',
      ) &&
      typeof payload === 'string'
    ) {
      try {
        const body = JSON.parse(payload);
        if (typeof body.token === 'string') setReadCookie(req, reply, body.token);
      } catch {
        /* Non-JSON error/response. */
      }
    }
    if (
      req.routeOptions.url === '/api/auth/me' &&
      reply.statusCode < 400 &&
      req.headers.authorization?.startsWith('Bearer ')
    )
      setReadCookie(req, reply, req.headers.authorization.slice(7));
    if (req.routeOptions.url === '/api/auth/logout' && reply.statusCode < 400)
      setReadCookie(req, reply, '', true);
    return payload;
  });

  /** Verifies a read token passed in the query (browser links: report, SSE). */
  async function readTokenAllowed(req: FastifyRequest): Promise<boolean> {
    if (!auth.enabled) return true;
    const { token } = req.query as { token?: string };
    const r = await resolveIdentity(
      token && verifyJwt(token, auth.secret)?.sub.startsWith('share:') && !singleUser
        ? ({ headers: { authorization: `Bearer ${token}` } } as FastifyRequest)
        : req.headers.authorization
          ? req
          : ({ headers: { authorization: `Bearer ${readCookie(req) ?? ''}` } } as FastifyRequest),
    );
    return r.ok && !r.mustChange && can(r.id.role, 'campaign:read', auth.userMode);
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

  const failureReferences = new WeakMap<object, string>();
  const backgroundExecutions = new Set<string>();
  function fail(err: unknown, reply: FastifyReply) {
    if (err instanceof CampaignError) return reply.code(400).send({ error: err.message });
    if (err instanceof AgentError) return reply.code(503).send({ error: err.message });
    const diagnosticId =
      (err && typeof err === 'object' ? failureReferences.get(err) : undefined) ?? randomUUID();
    app.log.error({ err, diagnosticId });
    if (err instanceof DrsBaselineError)
      return reply.code(422).send({
        error: err.message,
        code: 'baseline_rejected',
        diagnosticId,
        baselineDiagnostic: err.diagnostic,
      });
    return reply.code(500).send({ error: 'internal error', diagnosticId });
  }

  async function auditAs(
    actor: string,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) {
    await store.saveAudit({
      id: randomUUID(),
      at: new Date().toISOString(),
      actor,
      action,
      campaignId,
      detail,
    });
  }

  const audit = (
    req: FastifyRequest,
    action: AuditEntry['action'],
    campaignId?: string,
    detail?: string,
  ) => auditAs(req.authUser?.email ?? 'dev', action, campaignId, detail);

  /**
   * The EFFECTIVE allowlist enforced on every campaign/recon: the env allowlist
   * (`opts.allowedTargets`) plus the hosts a CISO has AUTHORIZED via the governed
   * target-onboarding flow. Only `authorized` targets extend it; unauthorized,
   * requested, or revoked targets never do. Fail-closed: on any store error it
   * falls back to the env allowlist alone, never widening it.
   */
  async function effectiveAllowlist(): Promise<string[]> {
    try {
      const extra = authorizedHosts(await store.listTargets());
      return extra.length ? [...allowedTargets, ...extra] : allowedTargets;
    } catch {
      return allowedTargets;
    }
  }

  async function runCampaign(
    c: Campaign,
    actor: string,
    recoveryBeforeRun?: RecoveryResult,
    onStarted?: () => void,
  ): Promise<CampaignRun> {
    if (kills.isStopping()) throw new CampaignError('Control plane is shutting down');
    assertExecutable(c);
    // Every actor (manual, suite and scheduler) uses current policy before any I/O.
    const currentCaps = clampToCeiling(await store.getLimits());
    const { drsDocument, ...executionInput } = c;
    if (c.drsMode === 'engine-validation')
      throw new CampaignError('Engine validation never dispatches traffic; use DRS simulation');
    if (c.drsMode === 'measured')
      throw new CampaignError(
        'Measured assessment requires independently qualified collectors and capacity',
      );
    if (drsDocument) {
      const revision = drsDocument.revisions.find((r) => r.number === drsDocument.currentRevision);
      if (revision?.plan.mode === 'engine-validation')
        throw new CampaignError(
          'Engine validation uses simulated events only; use the DRS simulation control',
        );
      if (!revision?.planHash || revision.finalizedAt)
        throw new CampaignError('A frozen active DRS plan is required');
      assessDrs(revision);
      const budget = revision.plan.budgets;
      if (
        c.maxRps > budget.maxRps ||
        c.concurrency > budget.concurrency ||
        c.maxDurationSec > budget.maxDurationSec ||
        (c.fleetDeviceIds?.length ?? 1) > budget.maxAgents
      )
        throw new CampaignError(
          'Campaign parameters exceed frozen DRS plan budgets; create a matching revision',
        );
      if (revision.plan.mode === 'measured')
        throw new CampaignError(
          'Measured DRS dispatch requires independently qualified collectors and scenario capacity; no local substitute is permitted',
        );
    }
    createCampaign(executionInput, await effectiveAllowlist(), agentChoices(), currentCaps);
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
    if (kills.count() >= maxConcurrentRuns)
      throw new CampaignError('Concurrent run budget exhausted.');
    if (parameterEdits.has(c.id)) throw new CampaignError('Campaign parameters are being updated.');
    const kill = new KillSwitch();
    kills.set(c.id, kill);
    const liveLabels = { target: new URL(c.target).hostname, vector: c.vector };
    let countedInFlight = false;
    try {
      await auditAs(
        actor,
        'campaign.execute',
        c.id,
        'Execution intent persisted before transport preparation',
      );
      c = { ...transition(c, 'RUNNING'), statusDetail: undefined };
      await store.saveCampaign(c);
      onStarted?.();
      let runAgent = await resolveCampaignAgent(c.agent, agent);
      // Measurement fidelity: the in-process built-in generator caps out at
      // BUILTIN_RPS_CEILING and silently under-delivers above it. When a
      // high-rate simple flood would run on the built-in engine, auto-route it
      // to an out-of-process engine (vegeta/k6) that can actually deliver the
      // configured rate — but only if that engine is installed; otherwise keep
      // built-in (still bounded/safe,
      // just rate-limited). See modules/campaigns/engine-route.ts.
      if (!c.agent && (opts.autoRouteHighRps ?? true) && runAgent.name === 'builtin-http') {
        const upgradeId = highRateEngineUpgrade(
          c,
          BUILTIN_RPS_CEILING,
          BUILTIN_CONCURRENCY_CEILING,
        );
        if (upgradeId) {
          const upgraded = createAgent(upgradeId);
          if (upgraded && (await upgraded.available())) {
            const why =
              c.maxRps > BUILTIN_RPS_CEILING
                ? `maxRps ${c.maxRps} > built-in ceiling ${BUILTIN_RPS_CEILING} rps`
                : `concurrency ${c.concurrency} > built-in ceiling ${BUILTIN_CONCURRENCY_CEILING} (event-loop safety)`;
            app.log.info(
              {
                evt: 'run.autoroute',
                campaignId: c.id,
                to: upgradeId,
                maxRps: c.maxRps,
                concurrency: c.concurrency,
              },
              `auto-routed to ${upgradeId} (${why})`,
            );
            runAgent = upgraded;
          }
        }
      }
      // Delivery fidelity (a measurement rule, NOT a safety cap): the in-process
      // engine is measured at BUILTIN_RPS_CEILING / BUILTIN_CONCURRENCY_CEILING and
      // silently under-delivers above it. When the high-rate upgrade could not
      // hand the run to an out-of-process engine — the shape is built-in-only
      // (dataset, body assertion, slowloris) or the binary is not installed —
      // refusing is the
      // honest outcome: the campaign would otherwise be graded on traffic that
      // never arrived. `calibrate: true` is the explicit opt-in that measures the
      // delivered amplitude and records it as calibrated instead.
      const underDelivery = builtinUnderDeliveryReason(
        c,
        runAgent.name,
        BUILTIN_RPS_CEILING,
        BUILTIN_CONCURRENCY_CEILING,
      );
      if (underDelivery) throw new CampaignError(underDelivery);
      // Track the worst event-loop lag seen during the run so we can flag the WRS
      // as measurement-degraded if the generator host was itself struggling.
      let peakEventLoopLagMs = 0;
      // Live per-run gauges (updated every tick) so Grafana animates the run in
      // real time, mirroring the app's Run Theater — offered/successful-response RPS,
      // absorbed ratio and legit-probe availability. The settle-time `_last`
      // gauges keep the post-run summary; these `_live` series are retired when the
      // run ends (see the finally block) so a finished run leaves no stale line.
      const onProgress = (p: LoadProgress) => {
        const revision = c.drsDocument?.revisions.find(
          (r) => r.number === c.drsDocument?.currentRevision,
        );
        if (revision?.state === 'BASELINE')
          transitionDrs(
            revision,
            'LEVEL_EXECUTION',
            'Bounded diagnostic generation; no full standard conditions inferred',
          );
        const lag = metrics.eventLoopLagMs();
        if (lag > peakEventLoopLagMs) peakEventLoopLagMs = lag;
        liveProgress.set(c.id, {
          ...p,
          maxDurationSec: c.maxDurationSec,
          status: 'RUNNING',
          engine: runAgent.name,
        });
        // The runner alone publishes Prometheus live gauges, on the same clock
        // and with the same provenance as its persisted samples.
      };
      // Seed a zeroed progress record immediately: the run opens with a baseline
      // capture (up to ten minutes for DRS) during which the engine emits no
      // progress. Without this seed the live stream would find no record and tell
      // the UI the run is "done", stranding the progress view on "Starting run…".
      // Cleared in the finally below; onProgress overwrites it once load begins.
      onProgress({
        generatorObserved: false,
        sent: 0,
        successful: 0,
        failed: 0,
        elapsedSec: 0,
        actualRps: 0,
      });
      let host = c.target;
      try {
        host = new URL(c.target).hostname;
      } catch {
        /* keep raw */
      }
      const runStartedMs = Date.now();
      metrics.addGauge('shieldtest_runs_in_flight', 'Campaign runs currently executing', 1);
      countedInFlight = true;
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
      const plannedRevision = c.drsDocument?.revisions.find(
        (r) => r.number === c.drsDocument?.currentRevision,
      );
      if (plannedRevision?.planHash) {
        transitionDrs(
          plannedRevision,
          'CAPACITY_CHECK',
          'Bounded adapter and shared envelope checked; full standard capacity not established',
        );
        transitionDrs(
          plannedRevision,
          'BASELINE',
          'Independent low-rate HTTP reference, minimum five minutes; functional journey remains separate evidence',
        );
        await store.saveCampaign(c);
      }
      const run = await executeCampaign(
        c,
        await effectiveAllowlist(),
        kill,
        onProgress,
        runAgent,
        protection,
        undefined,
        targetTelemetry,
      );
      // Ground truth: record the engine that actually ran (may differ from the
      // configured agent when a high-rate step was auto-routed). Read by the
      // report and the campaign drawer (no more guessing built-in vs external).
      run.engine = runAgent.name;
      const runDurationSec = (Date.now() - runStartedMs) / 1000;
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
      // Break absorption down by mechanism. rejected = the edge ANSWERED refusing
      // (a 4xx/5xx HTTP response). tarpitted = the edge HELD the connection until it
      // failed with NO HTTP response — a transport failure (timeout/reset/abort),
      // which external engines report as a `0xx`/`err` status bucket (vegeta maps
      // code 0 → "0xx"). Counting those `0xx` transport failures as "rejected" was
      // a mislabel: a 800-rps cache-busted GET that tarpits the origin to 10s
      // timeouts (statusCounts {0xx:77309, 2xx:18660}, p50 10s) read as
      // "edge rejected 4xx/5xx" when it was really a tarpit. So: `0xx`/`err` → tarpit.
      const { rejected, tarpitted } = splitFailures(
        run.generator.statusCounts ?? {},
        run.generator.errors ?? {},
      );
      // The PEAK offered rate (for display) — the calibrated deliverable ceiling
      // when the run was rate-calibrated (GEN-1), else the campaign's requested
      // peak. And the EXPECTED mean offered rate (the delivery denominator): a
      // wave/ramp offers its peak only at the crest, so its mean throughput is
      // below peak; measuring delivery against the peak would falsely flag a
      // faithfully-delivered wave/ramp as under-delivered. The scenario's mean/peak
      // ratio is shape-only (unchanged by calibration, which scales all phases),
      // so scale it by the effective peak.
      const effectivePeakRps = run.calibration?.appliedRps ?? c.maxRps;
      const shapeMeanRatio = c.maxRps > 0 ? scenarioMeanRps(c.maxRps, c.scenario) / c.maxRps : 1;
      const absorption = computeAbsorption({
        configuredRps: effectivePeakRps,
        expectedRps: Math.round(effectivePeakRps * shapeMeanRatio),
        achievedRps: run.generator.actualRps,
        totalRequests: run.generator.totalRequests,
        successful: run.generator.successful,
        failed: run.generator.failed,
        // Successful and offered rates must share the generator's window,
        // excluding orchestration/baseline time from the response-rate divisor.
        durationSec:
          run.generator.actualRps > 0
            ? run.generator.totalRequests / run.generator.actualRps
            : runDurationSec,
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
        'shieldtest_run_successful_rps_last',
        'RPS that reached origin (2xx/3xx) in the last run per target',
        absorption.originRps,
        runLabels,
      );
      metrics.setGauge(
        'shieldtest_run_failed_ratio_last',
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
        unfinalizedRequests: run.generator.unfinalizedRequests,
        hardStopped: run.generator.hardStopped,
        fleetIncomplete: run.generator.fleet?.measurementComplete === false,
        fleetCpuContention: fleetCpuContention(run.generator.fleet?.shards),
        peakEventLoopLagMs,
        killedAuto: run.status === 'KILLED_AUTO',
        generatorRequests: run.generator.totalRequests,
      });
      if (run.probeContended) {
        run.confidence.degraded = true;
        run.confidence.reasons.push(
          'Independent probe and generator disagree; probe measurements and kill thresholds were preserved.',
        );
      }
      if (run.baseline?.observation?.complete === false) {
        run.confidence.degraded = true;
        run.confidence.reasons.push(
          'Remote baseline observations are incomplete; target baseline availability and comparison remain uncertain.',
        );
      }
      if (c.probeVantage === 'remote') {
        const reasons = [
          ...remoteProbeQualityReasons(run.probe.quality),
          ...(run.baseline
            ? remoteProbeQualityReasons(run.baseline.quality).map((reason) => `Baseline: ${reason}`)
            : []),
        ];
        if (reasons.length) {
          run.confidence.degraded = true;
          run.confidence.reasons.push(...reasons);
        }
      }

      if (run.confidence.degraded) {
        metrics.inc(
          'shieldtest_run_confidence_degraded_total',
          'Runs whose WRS is flagged measurement-degraded (generator-side bottleneck)',
          runLabels,
        );
      }
      // Faithful assessment — the SAME engine the report uses, attached to the run
      // so the campaign detail page and the report always agree on the verdict.
      run.assessment = assessVector(run, {
        shape: c.name,
        drs: /DRS\s*([0-9])/i.exec(c.name)?.[1] ?? '—',
        status: run.status,
        vector: c.vector,
        h2Confirmed: c.reconPosture?.h2,
      });
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
            'shieldtest_run_edge_failed_ratio_last',
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
      if (recoveryBeforeRun) run.recoveryBeforeRun = recoveryBeforeRun;
      const drsRevision = c.drsDocument?.revisions.find(
        (r) => r.number === c.drsDocument?.currentRevision,
      );
      if (drsRevision?.planHash) {
        transitionDrs(
          drsRevision,
          'RECOVERY',
          'Injection ceased; full independent recovery evidence is not supplied by this diagnostic run',
        );
        drsRevision.attachments ??= [];
        drsRevision.attachments.push(runAttachment(run));
        finalizeDrs(drsRevision);
        run.drsAssessment = drsReport(drsRevision);
      }
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
      const diagnosticId = randomUUID();
      const reported =
        err instanceof Error ? err : new Error('Campaign execution failed', { cause: err });
      failureReferences.set(reported, diagnosticId);
      app.log.error({ err: reported, campaignId: c.id, diagnosticId }, 'campaign execution failed');
      const revision = c.drsDocument?.revisions.find(
        (r) => r.number === c.drsDocument?.currentRevision,
      );
      if (revision?.planHash && !revision.finalizedAt) {
        if (reported instanceof DrsBaselineError) revision.baselineDiagnostic = reported.diagnostic;
        transitionDrs(
          revision,
          'EVIDENCE_VALIDATION',
          `Physical execution interrupted (reference ${diagnosticId}); ${reported instanceof DrsBaselineError ? reported.message : 'no unobserved scenario counts as success'}`,
        );
        finalizeDrs(revision);
      }
      await store.saveCampaign({
        ...transition(c, 'APPROVED'),
        statusDetail: `Last run failed (reference ${diagnosticId}); ${reported instanceof DrsBaselineError ? reported.message : 'review before retrying.'}`,
      });
      await auditAs(
        actor,
        'campaign.execute',
        c.id,
        `Execution failed (reference ${diagnosticId}); ${(reported as Error).message}`,
      );
      throw reported;
    } finally {
      if (countedInFlight)
        metrics.addGauge('shieldtest_runs_in_flight', 'Campaign runs currently executing', -1);
      liveProgress.clear(c.id);
      kills.clear(c.id);
      // Retire the live per-run gauges — the run is over; its summary lives in
      // the settle-time `_last` gauges. Leaving these would strand a finished
      // run's last value as a stale flat line on the Grafana live panels.
      for (const g of [
        'shieldtest_run_live_offered_rps',
        'shieldtest_run_live_successful_rps',
        'shieldtest_run_live_failed_ratio',
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
  // the assessment). Two-step governance (matches a single campaign): a CISO
  // approves the scenario first (POST /suites/:id/approve), then an engineer runs
  // the approved steps here — the sequencer only executes APPROVED steps and never
  // approves. Runs in the background; progress is read from the member campaigns'
  // statuses. One sequence per suite.
  //
  // A sequence is controllable while it runs: PAUSE holds it between steps
  // (the current step finishes, the next does not start) until RESUME; CANCEL
  // stops it and kills the step in flight. The control lives in `suiteRuns` and
  // is exposed via GET /api/suites/sequences so the UI can render the state.
  interface SuiteControl {
    paused: boolean;
    pauseBetweenSteps?: boolean;
    editing?: boolean;
    cancelled: boolean;
    /** The member campaign currently executing (for a cancel to kill it). */
    current?: string;
    total: number;
    started: number;
    /** Consecutive unavailable or unverified recovery-gate skips. */
    downSkips: number;
    /** Paused by the sequencer itself because the target looked genuinely down
     *  (as opposed to a manual pause). Cleared on resume. */
    autoPaused?: boolean;
    /** Epoch ms when the recovery gate started waiting for the target to come
     *  back — set while the gate is blocking, cleared as soon as it settles. The
     *  UI turns this into a live countdown. Undefined = no gate in flight. */
    gateStartedAt?: number;
    /** The gate's max wait (ms) before it gives up and skips — so the UI can show
     *  "waited Xs / max Ys" and count down to the skip. */
    gateMaxWaitMs?: number;
  }
  const RECOVERY_MAX_WAIT_MS = 90_000;
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
      for (const [memberIndex, m] of members.entries()) {
        if (ctrl.cancelled) break;
        // Pause gate: hold between steps while paused (a cancel breaks out).
        while (ctrl.paused && !ctrl.cancelled) await sleepMs(400);
        if (ctrl.cancelled) break;
        // Re-fetch: earlier steps may have changed state (and to see manual kills).
        let c = await store.getCampaign(m.id);
        if (!c) continue;
        // Two-step flow: a CISO approves the scenario (POST /suites/:id/approve)
        // before an engineer runs it (POST /suites/:id/run, which refuses to start
        // while any step is still pending). The sequencer therefore NEVER approves —
        // it skips a still-pending step rather than self-approving it.
        if (c.status === 'PENDING_APPROVAL') {
          await auditAs(
            actor,
            'suite.skip',
            c.id,
            'awaiting approval — approve the scenario first',
          );
          continue;
        }
        if (c.status !== 'APPROVED') continue; // terminal / rejected → leave as-is
        // Recovery gate BETWEEN waves: once at least one step has run, don't start
        // the next wave until the target is reachable again (it may still be
        // recovering from the previous load). Bounded, so the suite never hangs;
        // if the target never recovers we skip the step rather than hammer a down
        // target. The wait time is recorded (a real recovery-time signal).
        let recoveryBeforeRun: RecoveryResult | undefined;
        if (opts.suiteRecovery !== false && ctrl.started > 0 && !ctrl.cancelled) {
          const recoveryOpts =
            typeof opts.suiteRecovery === 'object' ? opts.suiteRecovery : undefined;
          // Publish the gate's start + budget so the UI can show a live countdown.
          ctrl.gateStartedAt = Date.now();
          ctrl.gateMaxWaitMs = recoveryOpts?.maxWaitMs ?? RECOVERY_MAX_WAIT_MS;
          let gate;
          try {
            const recoveryRemote = c.probeVantage === 'remote' ? remoteProbeFromEnv() : undefined;
            if (c.probeVantage === 'remote' && !recoveryRemote)
              throw new Error('Remote recovery vantage is unavailable');
            gate = await waitForTargetAvailable(c.probeUrl || c.target, {
              isCancelled: () => ctrl.cancelled,
              ...(recoveryOpts ?? {}),
              remote: recoveryRemote ?? undefined,
            });
          } finally {
            ctrl.gateStartedAt = undefined; // gate settled — stop the countdown
          }
          const secs = Math.round(gate.waitedMs / 1000);
          recoveryBeforeRun = gate;
          if (!gate.available || gate.verified === false) {
            ctrl.downSkips += 1;
            await auditAs(
              actor,
              'suite.skip',
              c.id,
              `recovery ${gate.verified === false ? 'unverified' : 'unavailable'} after ${secs}s — skipped; ${JSON.stringify(gate)}`,
            );
            // Recovery remains unavailable or unverified. Stop
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
                `recovery unavailable or unverified — auto-paused after ${ctrl.downSkips} consecutive skips (protecting the target)`,
              );
            }
            continue;
          }
          ctrl.downSkips = 0;
          await auditAs(
            actor,
            'suite.gate',
            c.id,
            `recovery available after ${secs}s — proceeding; ${JSON.stringify(gate)}`,
          );
        }
        while (ctrl.paused && !ctrl.cancelled) await sleepMs(400);
        if (ctrl.cancelled) break;
        c = await store.getCampaign(m.id);
        if (!c || c.status !== 'APPROVED') continue;
        ctrl.current = c.id;
        ctrl.started += 1;
        try {
          await runCampaign(c, actor, recoveryBeforeRun); // awaits the step's terminal state
        } catch (err) {
          // A failed/blocked step still advances the sequence.
          await auditAs(actor, 'suite.skip', c.id, `run error: ${(err as Error).message}`);
        } finally {
          ctrl.current = undefined;
        }
        if (
          ctrl.pauseBetweenSteps &&
          members
            .slice(memberIndex + 1)
            .some((next) => ['APPROVED', 'PENDING_APPROVAL'].includes(next.status))
        ) {
          ctrl.paused = true;
          await auditAs(
            actor,
            'suite.pause',
            undefined,
            `Step completed; operator review required · ${suiteId}`,
          );
        }
      }
    } finally {
      suiteRuns.delete(suiteId);
    }
  }

  app.get('/health', async () => ({
    status: 'ok',
    drsWorkflow: drsWorkflow(),
    userMode: auth.userMode ?? 'team',
    accessContractVersion: ACCESS_CONTRACT_VERSION,
    accountPolicy: (await store.getAccountPolicy()) ? 'single_admin' : 'legacy_team',
    // Build stamp of THIS running server — lets you confirm which commit the API
    // actually serves (the frontend footer only reflects the bundle it shipped).
    version: getBuildInfo(),
    // Governance posture: does this deployment require a CISO sign-off on every
    // campaign (dual control)? The UI reads this to show/gate the CISO step.
    requireCisoApproval,
    // Effective allowlist = env allowlist + CISO-authorized onboarded targets, so
    // the UI's notion of testable hosts matches enforcement.
    allowedTargets: await effectiveAllowlist(),
    labTargets,
    storage: store.backend,
    authRequired: auth.enabled,
    agent: agent.name,
    notifications: notifier.sinks,
    protection: protection.configured,
    targetTelemetry: targetTelemetry.configured,
    // Whether a remote read-only probe agent is configured (e.g. VPS2 over the
    // tailnet). The UI shows the per-campaign "probe vantage" toggle only when true.
    remoteProbe: remoteProbeFromEnv() !== null,
    tlsInsecure: tlsInsecure(),
    // `hardCaps` = the EFFECTIVE operational caps the server enforces right now
    // (the CISO-set limits, or the ceiling when unset). The frontend reads these
    // for its inline hints, so it always matches enforcement. `hardCapsCeiling`
    // is the immutable absolute ceiling (config/limits.ts) — the CISO can never
    // set an operational cap above it.
    hardCaps: effectiveCaps,
    hardCapsCeiling: { ...HARD_CAPS },
    // Built-in engine performance ceilings (config/limits.ts). Above EITHER, a
    // simple flood auto-routes to an out-of-process engine — the frontend reads
    // these to predict, at config time, whether a configured rate/concurrency
    // will actually be delivered by the built-in engine or routed away.
    builtinCeilings: {
      rps: BUILTIN_RPS_CEILING,
      concurrency: BUILTIN_CONCURRENCY_CEILING,
    },
    // Observability: whether the app-native Prometheus charts have a data source,
    // and the Grafana base URL (+ run dashboard uid) for the "Open in Grafana"
    // deep-links. Null when unconfigured — the UI then hides the Grafana links.
    metrics: {
      prometheus: !!opts.prometheusUrl,
      grafanaUrl: opts.grafanaUrl ?? null,
      runDashboardUid: 'shieldtest-run',
    },
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
    return reply.send({
      ceiling: { ...HARD_CAPS },
      effective: effectiveCaps,
    });
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
    const { target, probeUrl, actions } = req.query as {
      target?: string;
      probeUrl?: string;
      // Opt-in (P7): also return the ranked recon-suggested action set. Absent →
      // the response is byte-identical to the recon report alone.
      actions?: string;
    };
    if (!target) return reply.code(400).send({ error: 'target is required' });
    const agents = await describeAgents();
    try {
      const report = await runRecon(
        target,
        probeUrl ?? target,
        await effectiveAllowlist(),
        {
          enginesAvailable: agents.filter((a) => a.available).length,
          capsConfigured: true,
          protectionConfigured: protection.configured,
          labRunnerConfigured: labTargets.length > 0,
        },
        AbortSignal.timeout(15000),
      );
      if (!actions) return report;
      const suggested = recommendActions(report, {
        catalogue: PLAYBOOKS,
        engines: agents.map((a) => ({ id: a.id, available: a.available })),
        caps: effectiveCaps,
        target,
        probeUrl: probeUrl ?? target,
        createdBy: req.authUser?.email ?? 'recommender',
      });
      return { ...report, actions: suggested };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Best-effort recon used to seed a suite's endpoints from the target's real
  // published surface (systematic recon). Never throws: on failure the caller
  // falls back to the template paths and the summary says so.
  interface ReconSeedResult {
    surface?: { paths: string[]; dynamicPaths?: string[]; loginPath?: string };
    /** Compact {h2,waf,cache,dynamic} posture for the report's requires→N/A check. */
    posture?: ReconPostureSnapshot;
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
  async function reconSeed(
    target: string,
    probeUrl: string,
    engines: readonly { available: boolean }[],
  ): Promise<ReconSeedResult> {
    try {
      const availN = engines.filter((a) => a.available).length;
      const recon = await Promise.race([
        runRecon(
          target,
          probeUrl,
          await effectiveAllowlist(),
          {
            enginesAvailable: availN,
            capsConfigured: true,
            protectionConfigured: protection.configured,
            labRunnerConfigured: labTargets.length > 0,
          },
          AbortSignal.timeout(RECON_SEED_TIMEOUT_MS),
        ),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('recon timed out')), RECON_SEED_TIMEOUT_MS);
          t.unref?.();
        }),
      ]);
      // Single source of the posture→requirement mapping (see reconPostureSnapshot).
      const posture: ReconPostureSnapshot = reconPostureSnapshot(recon);
      return {
        surface: {
          paths: recon.suggestedPaths,
          dynamicPaths: recon.dynamicPaths,
          loginPath: recon.loginPath,
        },
        posture,
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

  async function validateSuiteDestinations(target: string, probeUrl: string): Promise<void> {
    const allowed = await effectiveAllowlist();
    try {
      assertDestination(target, allowed);
      assertDestination(probeUrl, allowed);
    } catch (err) {
      throw new CampaignError((err as Error).message);
    }
  }

  // Cost budgets are checked before scrypt, independently of attacker-controlled email.
  const loginBudget = new Map<string, { at: number; count: number }>();
  let globalLoginWindow = { at: Date.now(), count: 0 };
  const acceptLoginCost = (ip: string): boolean => {
    const now = Date.now();
    if (now - globalLoginWindow.at >= 60000) globalLoginWindow = { at: now, count: 0 };
    for (const [key, value] of loginBudget) if (now - value.at >= 60000) loginBudget.delete(key);
    const source = loginBudget.get(ip) ?? { at: now, count: 0 };
    if (
      source.count >= 20 ||
      globalLoginWindow.count >= 100 ||
      (!loginBudget.has(ip) && loginBudget.size >= 1000)
    )
      return false;
    source.count++;
    globalLoginWindow.count++;
    loginBudget.set(ip, source);
    return true;
  };

  // Anti-brute-force: temporary lock after several failures (per email+IP).
  const loginFails = new Map<string, { count: number; until: number }>();
  const MAX_FAILS = 5;
  const LOCK_MS = 60_000;

  // A fixed decoy hash so a login for a NON-EXISTENT account still pays one
  // scrypt verification — otherwise "no such account" returns faster than "wrong
  // password", a timing oracle that enumerates valid emails. Computed once.
  const decoyHash = hashPassword('constant-time-decoy-not-a-credential');
  app.post(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', minLength: 1, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
          required: ['email', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      if (!auth.enabled) return reply.code(400).send({ error: 'authentication disabled' });
      const { email, password } = req.body as {
        email?: string;
        password?: string;
      };
      if (!email || !password)
        return reply.code(400).send({ error: 'email and password required' });
      for (const [bucket, failure] of loginFails)
        if (failure.until < Date.now()) loginFails.delete(bucket);
      if (loginFails.size >= 10_000) loginFails.delete(loginFails.keys().next().value!);
      if (!acceptLoginCost(req.ip))
        return reply.code(429).send({ error: 'login capacity exceeded — try again later' });
      const key = `${email.toLowerCase()}|${req.ip}`;
      const entry = loginFails.get(key);
      if (entry && entry.count >= MAX_FAILS && Date.now() < entry.until) {
        return reply.code(429).send({ error: 'too many attempts — try again later' });
      }
      const rejectLogin = async (reason: string, actor: string) => {
        const count = (entry?.count ?? 0) + 1;
        loginFails.set(key, { count, until: Date.now() + LOCK_MS });
        req.log.warn({ email: email.toLowerCase(), ip: req.ip, reason }, 'login failed');
        // Every failure is a Prometheus counter (labelled by REASON only — never by
        // email, which an attacker controls and would explode series cardinality),
        // so alerting can catch low-and-slow credential guessing that never trips
        // the 5-attempt lock and so never reaches the audit chain.
        metrics.inc('shieldtest_auth_login_failures_total', 'Failed login attempts by reason', {
          reason,
        });
        // Only the lock event reaches the (tamper-evident) audit chain, not every
        // attempt — enough to flag an attack without flooding the governance log.
        if (count === MAX_FAILS) {
          metrics.inc('shieldtest_auth_lockouts_total', 'Login lockouts triggered (per source)');
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
      let res = await login(auth, email, password);
      let mustChangePassword = false;
      if (res) {
        await auditAs(res.email, 'auth.login', undefined, 'env user');
      } else {
        const su = await store.getUser(email.toLowerCase());
        if (!su) {
          // Constant-time: burn an equivalent scrypt against the decoy so a missing
          // account is indistinguishable by response time from a wrong password.
          await verifyPasswordAsync(password, decoyHash);
        } else if (await verifyPasswordAsync(password, su.passwordHash)) {
          // Correct credentials but a deactivated account: refuse with the same
          // generic message (no oracle), and record the reason out of band.
          if ((su.status ?? 'active') === 'disabled') {
            return rejectLogin('account disabled', su.email);
          }
          await store.recordLogin(su.email, new Date().toISOString());
          mustChangePassword = !!su.mustChangePassword;
          // Canonicalise the stored role (maps the legacy `officer` id to `admin`)
          // so both the token and the login response carry a current Role — the
          // same normalisation `identityFromRequest` applies on every request.
          const role = canonicalRole(su.role) ?? su.role;
          res = {
            token: signJwt({ sub: su.email, role, ver: su.tokenVersion ?? 0 }, auth.secret),
            email: su.email,
            role,
          };
          await auditAs(su.email, 'auth.login', undefined, undefined);
        }
      }
      if (!res) return rejectLogin('bad credentials', email.toLowerCase());
      loginFails.delete(key);
      metrics.inc('shieldtest_auth_logins_total', 'Successful logins');
      return { ...res, mustChangePassword, ...accessContract(res.role) };
    },
  );

  // Logout REALLY revokes: bump the store user's token version so the presented
  // token (and any other live session for that user) stops validating at once,
  // via resolveIdentity's version check — instead of a cosmetic client-side
  // discard that left the token usable until its expiry. Env-root and share
  // identities have no store row (env accounts are managed via configuration).
  app.post('/api/auth/logout', async (req, reply) => {
    if (!auth.enabled) return { ok: true };
    const r = await resolveIdentity(req);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    req.authUser = r.id;
    const email = r.id.email.toLowerCase();
    if (!auth.users.has(email) && !email.startsWith('share:')) {
      await store.transactionUsers(async (tx) => {
        const su = await tx.getUser(email);
        const payload = payloadFromRequest(auth, req);
        if (su && (!payload || (payload.ver ?? 0) !== (su.tokenVersion ?? 0)))
          throw new Error('Stale logout session.');
        if (su) await tx.saveUser({ ...su, tokenVersion: (su.tokenVersion ?? 0) + 1 });
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: email,
          action: 'auth.logout',
        });
      });
    }
    if (auth.users.has(email) || email.startsWith('share:')) await audit(req, 'auth.logout');
    return { ok: true };
  });

  // Self-service password change — works even while a forced change is pending.
  // Store users only (env passwords are managed via configuration). Bumps the
  // revocation epoch (killing other sessions) and returns a fresh token so the
  // current session survives.
  app.post(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            currentPassword: { type: 'string', maxLength: 1024 },
            newPassword: { type: 'string', maxLength: 1024 },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
      const r = await resolveIdentity(req);
      if (!r.ok) return reply.code(r.code).send({ error: r.error });
      req.authUser = r.id;
      const email = r.id.email.toLowerCase();
      if (auth.users.has(email))
        return reply.code(400).send({
          error: 'Your account is managed via configuration and cannot self-change here.',
        });
      const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
      return store.transactionUsers(async (tx) => {
        const su = await tx.getUser(email);
        if (!su) return reply.code(404).send({ error: 'user not found' });
        const payload = payloadFromRequest(auth, req);
        if (!payload || (payload.ver ?? 0) !== (su.tokenVersion ?? 0))
          return reply.code(401).send({ error: 'session expired — sign in again' });
        if (!(await verifyPasswordAsync(body.currentPassword ?? '', su.passwordHash)))
          return reply.code(400).send({ error: 'Current password is incorrect.' });
        const password = body.newPassword ?? '';
        const problem = passwordProblem(password, email);
        if (problem) return reply.code(400).send({ error: problem });
        if (await verifyPasswordAsync(password, su.passwordHash))
          return reply.code(400).send({ error: 'New password must differ from the current one.' });
        const ver = (su.tokenVersion ?? 0) + 1;
        await tx.saveUser({
          ...su,
          passwordHash: await hashPasswordAsync(password),
          mustChangePassword: false,
          tokenVersion: ver,
        });
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: email,
          action: 'password.change',
          detail: email,
        });
        return {
          token: signJwt({ sub: su.email, role: su.role, ver }, auth.secret),
          email: su.email,
          role: su.role,
          mustChangePassword: false,
          ...accessContract(su.role),
        };
      });
    },
  );
  app.post(
    '/api/auth/sessions/revoke',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
      const email = req.authUser!.email.toLowerCase();
      return store.transactionUsers(async (tx) => {
        const su = await tx.getUser(email);
        if (!su)
          return reply.code(400).send({ error: 'Import this account before revoking sessions.' });
        const payload = payloadFromRequest(auth, req);
        if (!payload || (payload.ver ?? 0) !== (su.tokenVersion ?? 0))
          return reply.code(401).send({ error: 'session expired — sign in again' });
        const ver = (su.tokenVersion ?? 0) + 1;
        await tx.saveUser({ ...su, tokenVersion: ver });
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: email,
          action: 'auth.sessions_revoke',
          detail: 'Other sessions revoked; current session rotated.',
        });
        return {
          token: signJwt({ sub: su.email, role: su.role, ver }, auth.secret),
          email: su.email,
          role: su.role,
          ...accessContract(su.role),
        };
      });
    },
  );

  // Mint a short-lived, read-only share token for report links. Downgraded to
  // the viewer role regardless of the caller — a share link can only read.
  app.post('/api/share', { preHandler: guard('campaign:read') }, async (req, reply) => {
    if (singleUser)
      return reply.code(409).send({ error: 'Share tokens are disabled in single-user mode.' });
    if (!auth.enabled) {
      return reply.send({
        authRequired: false,
        token: null,
        expiresAt: null,
      });
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
        return reply.code(400).send({
          error: 'DRS validation is disabled (no LAB_TARGETS configured).',
        });
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
        return reply.code(400).send({
          error: 'class must be A or B (class C is out of scope — network bench).',
        });
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
    ladders: CLASS_C_LADDERS,
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
      return reply.code(409).send({
        error: `run is ${existing.status}, not CLAIMED — cannot post a result`,
      });
    }
    const b = (req.body ?? {}) as { verdict?: unknown; error?: string };
    if (b.error && !b.verdict) {
      const updated = await store.setBenchRunResult(id, {
        error: String(b.error).slice(0, 500),
      });
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
    const record: BenchCoverage = {
      ...entry,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
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
    const record: BenchCoverage = {
      ...entry,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
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
      const b = (req.body ?? {}) as {
        format?: string;
        data?: unknown;
        source?: string;
      };
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
        const record: BenchCoverage = {
          ...entry,
          id: randomUUID(),
          at: new Date().toISOString(),
        };
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
      return reply.code(201).send({
        imported: saved.length,
        errors: parsed.errors,
        records: saved,
      });
    },
  );

  // Reachable during a forced password change (unlike guarded routes) so the UI
  // can learn it must send the operator to the change-password screen.
  app.get('/api/auth/me', async (req, reply) => {
    if (!auth.enabled) return { email: null, role: null, authRequired: false };
    const r = await resolveIdentity(req);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    req.authUser = r.id;
    return {
      email: r.id.email,
      role: r.id.role,
      mustChangePassword: r.mustChange,
      ...accessContract(r.id.role),
    };
  });

  registerUserRoutes(app, { store, auth, guard });
  registerFleetRoutes(app, store, guard);
  registerDrsRoutes(app, store, guard);
  await registerFleetMissionRoutes(
    app,
    store,
    guard,
    auth,
    () => effectiveCaps,
    undefined,
    effectiveAllowlist,
  );

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
      const campaign = createCampaign(
        input,
        await effectiveAllowlist(),
        agentChoices(),
        effectiveCaps,
      );
      await store.saveCampaign(campaign);
      await audit(req, 'campaign.create', campaign.id, `${campaign.name} → ${campaign.target}`);
      return reply.code(201).send(campaign);
    } catch (err) {
      return fail(err, reply);
    }
  });

  // Measured capacity and the envelope it implies. The service ceiling defaults to the
  // immutable cap, so nothing escalates unless an operator sets SERVICE_CEILING_RPS.
  app.get('/api/drs/capacity', { preHandler: guard('campaign:read') }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (raw: string | undefined, fallback: number) => {
      const x = Number(raw);
      return Number.isFinite(x) && x > 0 ? x : fallback;
    };
    const ceiling = {
      maxRps: num(process.env.SERVICE_CEILING_RPS, HARD_CAPS.maxRps),
      maxConcurrency: num(process.env.SERVICE_CEILING_CONCURRENCY, HARD_CAPS.maxConcurrency),
      maxDurationSec: HARD_CAPS.maxDurationSec,
    };
    const scope = {
      maxRps: num(q.rps, ceiling.maxRps),
      maxConcurrency: num(q.concurrency, ceiling.maxConcurrency),
      maxDurationSec: num(q.duration, ceiling.maxDurationSec),
      targets: [] as string[],
    };
    const calibrations = await store.listAgentCalibrations();
    const envelope = deriveEnvelope({
      scope,
      agents: calibrations.map((c) => ({
        id: c.agentId,
        measuredTps: c.measuredTps,
        measuredConcurrency: c.measuredConcurrency,
        measuredAt: c.measuredAt,
        conditions: c.conditions,
      })),
      ceiling,
    });
    return {
      ceiling,
      scope,
      envelope,
      calibrations,
      reachability: levelReachability(drsReference().vectors, envelope, {
        quantity: parseQuantity,
      }),
    };
  });

  app.post(
    '/api/drs/calibrations',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      try {
        const calibration = parseCalibration(req.body);
        await store.saveAgentCalibration(calibration);
        await audit(
          req,
          'drs.calibration',
          calibration.agentId,
          `${calibration.measuredTps} rps / ${calibration.measuredConcurrency} concurrent`,
        );
        return reply.code(201).send(calibration);
      } catch (err) {
        if (err instanceof CalibrationError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get('/api/drs/catalog', { preHandler: guard('campaign:read') }, async () => {
    const catalogue = drsCatalog();
    return {
      ...catalogue,
      executionCaps: {
        ...catalogue.executionCaps,
        maxRps: Math.min(catalogue.executionCaps.maxRps, effectiveCaps.maxRps),
        maxConcurrency: Math.min(
          catalogue.executionCaps.maxConcurrency,
          effectiveCaps.maxConcurrency,
        ),
        maxDurationSec: Math.min(
          catalogue.executionCaps.maxDurationSec,
          effectiveCaps.maxDurationSec,
        ),
      },
    };
  });

  // Assessment playbooks: curated + user-defined sequences of bounded campaigns.
  app.get('/api/playbooks', { preHandler: guard('campaign:read') }, async () => {
    if (drsWorkflow())
      return drsCatalog().profiles.map((p) => ({
        ...p,
        category: 'DRS 3.00.00 reference',
        drsLevel: p.level,
        steps: [],
        createdAt: '2026-08-04T00:00:00.000Z',
      }));
    const curated = PLAYBOOKS.map((p) => ({ ...p, custom: false }));
    const custom = await store.listPlaybooks();
    return [...curated, ...custom];
  });

  app.post('/api/playbooks', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      if (drsWorkflow())
        return reply
          .code(409)
          .send({ error: 'The DRS catalogue is versioned; custom templates are retired.' });
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
      if (drsWorkflow())
        return reply.code(409).send({
          error:
            'Configure a DRS Fleet profile from the catalogue; legacy template instantiation is retired.',
        });
      const id = (req.params as { id: string }).id;
      const pb = getPlaybook(id) ?? (await store.getPlaybook(id));
      if (!pb) return reply.code(404).send({ error: 'playbook not found' });
      const body = req.body as {
        target?: string;
        probeUrl?: string;
        recurrenceMin?: number;
      };
      if (!body.target) return reply.code(400).send({ error: 'target is required' });
      try {
        await validateSuiteDestinations(body.target, body.probeUrl || body.target);
        const engines = (await describeAgents()).map((a) => ({
          id: a.id,
          available: a.available,
        }));
        // Systematic recon: seed the suite's endpoints from the target's real
        // published surface so path-based lines can't flood non-existent paths
        // (404). Best-effort and non-blocking (see reconSeed).
        const seed = await reconSeed(body.target, body.probeUrl || body.target, engines);
        const inputs = buildSuiteCampaigns(
          pb,
          {
            target: body.target,
            probeUrl: body.probeUrl || body.target,
            createdBy: req.authUser?.email ?? 'dev',
            recurrenceMin: body.recurrenceMin,
            recon: seed.surface,
            reconPosture: seed.posture,
          },
          engines,
        );
        const created: Campaign[] = [];
        for (const input of inputs) {
          const campaign = createCampaign(
            input,
            await effectiveAllowlist(),
            agentChoices(),
            effectiveCaps,
          );
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
        return reply.code(201).send({
          suiteId: created[0]?.suiteId,
          campaigns: created,
          recon: seed.summary,
        });
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Compose several templates into ONE suite (their steps concatenated in the
  // given order under a single suiteId). Behaves like any other suite from
  // there on: sequencer, aggregate WRS, one assessment report.
  app.post('/api/suites/compose', { preHandler: guard('campaign:create') }, async (req, reply) => {
    if (drsWorkflow())
      return reply.code(409).send({
        error: 'Legacy compositions are retired. Configure an executable DRS Fleet profile.',
      });
    const body = req.body as {
      playbookIds?: string[];
      name?: string;
      target?: string;
      probeUrl?: string;
      recurrenceMin?: number;
    };
    const ids = Array.isArray(body.playbookIds) ? body.playbookIds : [];
    if (ids.length < 1) {
      return reply.code(400).send({
        error: 'playbookIds must list at least one template to compose',
      });
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
      await validateSuiteDestinations(body.target, body.probeUrl || body.target);
      const engines = (await describeAgents()).map((a) => ({
        id: a.id,
        available: a.available,
      }));
      // Systematic recon-seeding (same as single-playbook instantiation).
      const seed = await reconSeed(body.target, body.probeUrl || body.target, engines);
      const inputs = buildCompositeSuite(
        playbooks,
        name,
        {
          target: body.target,
          probeUrl: body.probeUrl || body.target,
          createdBy: req.authUser?.email ?? 'dev',
          recurrenceMin: body.recurrenceMin,
          recon: seed.surface,
          reconPosture: seed.posture,
        },
        engines,
      );
      const created: Campaign[] = [];
      for (const input of inputs) {
        const campaign = createCampaign(
          input,
          await effectiveAllowlist(),
          agentChoices(),
          effectiveCaps,
        );
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
      return reply.code(201).send({
        suiteId: created[0]?.suiteId,
        campaigns: created,
        recon: seed.summary,
      });
    } catch (err) {
      return fail(err, reply);
    }
  });

  // P7: compose a governed suite (or a single campaign) from TUNED action seeds —
  // the operator's edited CampaignInput lines, not template ids. Each still goes
  // through createCampaign (allowlist + caps + `authorized`), so governance is
  // identical to every other create path; only the composition source differs.
  app.post(
    '/api/suites/from-actions',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      if (drsWorkflow())
        return reply
          .code(409)
          .send({ error: 'Action-derived suites are retired in DRS Fleet mode.' });
      const body = req.body as { name?: string; campaigns?: CampaignInput[] };
      const inputs = Array.isArray(body.campaigns) ? body.campaigns : [];
      if (inputs.length < 1) {
        return reply.code(400).send({ error: 'campaigns must list at least one action' });
      }
      if (inputs.length > MAX_COMPOSITE_STEPS) {
        return reply.code(400).send({
          error: `composed suite has ${inputs.length} actions; the maximum is ${MAX_COMPOSITE_STEPS}`,
        });
      }
      const asSuite = inputs.length > 1;
      const suiteId = asSuite ? randomUUID() : undefined;
      const suiteName = asSuite
        ? (body.name?.trim() || `Composite — ${inputs.length} actions`).slice(0, 120)
        : undefined;
      try {
        const created: Campaign[] = [];
        let order = 0;
        for (const raw of inputs) {
          const input: CampaignInput = {
            ...raw,
            createdBy: req.authUser?.email ?? raw.createdBy ?? 'dev',
            suiteId,
            suiteName,
            suiteOrder: asSuite ? order : undefined,
          };
          const campaign = createCampaign(
            input,
            await effectiveAllowlist(),
            agentChoices(),
            effectiveCaps,
          );
          await store.saveCampaign(campaign);
          created.push(campaign);
          order++;
        }
        await audit(
          req,
          'campaign.create',
          undefined,
          `actions → ${created.length} campaigns${suiteId ? ` (suite ${suiteId})` : ''}`,
        );
        return reply.code(201).send({ suiteId, campaigns: created });
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

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
        const updated = approveCampaign(c, approvedBy, body.decision, body.reason, {
          singleUser: adminConfirmation(req),
        });
        if (parameterEdits.has(c.id))
          return reply.code(409).send({ error: 'Campaign parameters are being updated.' });
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
        if (parameterEdits.has(c.id))
          return reply.code(409).send({ error: 'Campaign parameters are being updated.' });
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
        if (parameterEdits.has(c.id))
          return reply.code(409).send({ error: 'Campaign parameters are being updated.' });
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
      const body = (req.body ?? {}) as {
        scope?: string;
        namePrefix?: unknown;
      };
      const scope = body.scope === 'all' ? 'all' : 'settled';
      // Optional selective purge: only delete campaigns whose name starts with one
      // of these prefixes (e.g. clearing test-harness runs while keeping real
      // assessments). Bounded to keep the filter simple and safe.
      const prefixes = Array.isArray(body.namePrefix)
        ? body.namePrefix
            .filter((p): p is string => typeof p === 'string' && p.length > 0)
            .slice(0, 50)
        : null;
      const campaigns = await store.listCampaigns();
      const nameMatch = (c: { name: string }) =>
        !prefixes || prefixes.some((p) => c.name.startsWith(p));
      let killed = 0;
      if (scope === 'all') {
        for (const c of campaigns) {
          if (c.status === 'RUNNING' && nameMatch(c)) {
            kills.get(c.id)?.trigger('KILLED_MANUAL');
            killed++;
          }
        }
      }
      const deletable =
        scope === 'all'
          ? [...TERMINAL_STATUSES, 'PENDING_APPROVAL', 'APPROVED']
          : [...TERMINAL_STATUSES];
      const ids = campaigns
        .filter((c) => deletable.includes(c.status) && nameMatch(c))
        .map((c) => c.id);
      const deleted = await store.deleteCampaigns(ids);
      await audit(
        req,
        'campaign.purge',
        undefined,
        `scope=${scope} deleted=${deleted} killed=${killed}${prefixes ? ` prefixes=${prefixes.join(',')}` : ''}`,
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
      let c = await store.getCampaign((req.params as { id: string }).id);
      if (!c) return reply.code(404).send({ error: 'campaign not found' });
      if (parameterEdits.has(c.id))
        return reply.code(409).send({ error: 'Campaign parameters are being updated.' });
      if (backgroundExecutions.has(c.id))
        return reply.code(409).send({ error: 'This campaign already has an execution in flight.' });
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
        if (adminConfirmation(req)) {
          if ((req.body as { confirmed?: unknown } | undefined)?.confirmed !== true) {
            return reply.code(400).send({
              error: 'Explicit run confirmation is required.',
              code: 'confirmation_required',
            });
          }
          // Authoring rejects client-supplied evidence; this document came from storage.
          const executionInput = { ...c };
          delete executionInput.drsDocument;
          createCampaign(executionInput, await effectiveAllowlist(), agentChoices(), effectiveCaps);
          if (c.status === 'PENDING_APPROVAL') {
            c = approveCampaign(
              c,
              req.authUser!.email,
              'APPROVED',
              'Single-user run confirmation',
              { singleUser: adminConfirmation(req) },
            );
            await store.saveCampaign(c);
          }
          await audit(
            req,
            'campaign.confirm',
            c.id,
            `Confirmed ${c.target}: ${c.maxRps} RPS, ${c.concurrency} concurrent, ${c.maxDurationSec}s`,
          );
        }
        assertExecutable(c, { requireCiso: requireCisoApproval });
      } catch (err) {
        return fail(err, reply);
      }
      // Separation of duties (extended): the officer who approved a campaign may
      // not also execute it. Author≠approver is enforced at approval; this closes
      // the remaining concentration (approver≠executor). Only meaningful when
      // auth identifies the actor.
      const executor = req.authUser?.email;
      if (
        !adminConfirmation(req) &&
        executor &&
        c.approvedBy &&
        executor.toLowerCase() === c.approvedBy.toLowerCase()
      ) {
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
        if ((req.body as { background?: unknown } | undefined)?.background === true) {
          if (backgroundExecutions.size >= maxConcurrentRuns)
            return reply.code(429).send({ error: 'Concurrent execution budget exhausted.' });
          const campaign = c;
          backgroundExecutions.add(c.id);
          // Resolve only after validation, the kill registration and RUNNING persistence.
          // Consume later rejection: runCampaign retains the diagnostic/report in storage.
          await new Promise<void>((resolve, reject) => {
            void runCampaign(campaign, req.authUser?.email ?? 'dev', undefined, resolve)
              .catch(reject)
              .finally(() => backgroundExecutions.delete(campaign.id));
          });
          const statusUrl = `/api/campaigns/${c.id}`;
          return reply
            .code(202)
            .header('Location', statusUrl)
            .send({ campaignId: c.id, statusUrl });
        }
        const run = await runCampaign(c, req.authUser?.email ?? 'dev');
        return reply.code(201).send(run);
      } catch (err) {
        return fail(err, reply);
      }
    },
  );

  // Two-step flow — step 1: a CISO approves every still-pending step of a suite
  // (no run). Mirrors approving a single campaign, applied to the whole scenario.
  app.post(
    '/api/suites/:id/approve',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
      if (members.length === 0) return reply.code(404).send({ error: 'suite not found' });
      const actor = req.authUser?.email ?? 'dev';
      let approved = 0;
      let skipped = 0;
      for (const m of members) {
        if (m.status !== 'PENDING_APPROVAL') continue;
        try {
          if (parameterEdits.has(m.id))
            throw new CampaignError('Campaign parameters are being updated.');
          await store.saveCampaign(
            approveCampaign(m, actor, 'APPROVED', undefined, {
              singleUser: adminConfirmation(req),
            }),
          );
          approved += 1;
        } catch {
          // A step the approver authored can't be self-approved (author≠approver);
          // leave it pending and let a different CISO approve it.
          skipped += 1;
        }
      }
      await audit(
        req,
        'campaign.approve',
        undefined,
        `suite ${suiteId} — ${approved} step(s) approved`,
      );
      return reply.send({ suiteId, approved, skipped });
    },
  );

  // Reject a whole scenario at once — the suite-level counterpart to a single
  // campaign's Reject, so a template campaign offers the same governance actions
  // as a basic one. Rejects every PENDING_APPROVAL step (a reason is mandatory,
  // exactly as for a single rejection); already-decided steps are left as-is.
  app.post(
    '/api/suites/:id/reject',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      const suiteId = (req.params as { id: string }).id;
      const reason = (req.body as { reason?: string })?.reason?.trim();
      if (!reason) return reply.code(400).send({ error: 'A rejection must include a reason.' });
      const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
      if (members.length === 0) return reply.code(404).send({ error: 'suite not found' });
      const actor = req.authUser?.email ?? 'dev';
      let rejected = 0;
      let skipped = 0;
      for (const m of members) {
        if (m.status !== 'PENDING_APPROVAL') continue;
        try {
          await store.saveCampaign(
            approveCampaign(m, actor, 'REJECTED', reason, { singleUser: adminConfirmation(req) }),
          );
          rejected += 1;
        } catch {
          // A step the actor authored can't be self-rejected either — leave it.
          skipped += 1;
        }
      }
      await audit(
        req,
        'campaign.reject',
        undefined,
        `suite ${suiteId} — ${rejected} step(s) rejected: ${reason}`,
      );
      return reply.send({ suiteId, rejected, skipped });
    },
  );

  // Two-step flow — step 2: an engineer runs the APPROVED steps of a suite in
  // order (fire-and-forget; advances through auto-kills). Refuses to start while
  // any step is still pending — approve the scenario first.
  const parameterEdits = new Set<string>();
  app.get(
    '/api/campaigns/:id/parameters',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const c = await store.getCampaign((req.params as { id: string }).id);
      if (!c) return reply.code(404).send({ error: 'campaign not found' });
      try {
        editableParameters(c);
      } catch (err) {
        return fail(err, reply);
      }
      return {
        campaign: c,
        revision: parameterRevision(c),
        limits: clampToCeiling(await store.getLimits()),
        builtin: { rps: BUILTIN_RPS_CEILING, concurrency: BUILTIN_CONCURRENCY_CEILING },
      };
    },
  );
  app.post(
    '/api/campaigns/:id/parameters',
    { preHandler: guard('campaign:create') },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (parameterEdits.has(id) || backgroundExecutions.has(id) || kills.get(id))
        return reply.code(409).send({ error: 'Campaign is busy.' });
      parameterEdits.add(id);
      let control: SuiteControl | undefined;
      let editingReserved = false;
      try {
        const c = await store.getCampaign(id);
        if (!c) return reply.code(404).send({ error: 'campaign not found' });
        control = c.suiteId ? suiteRuns.get(c.suiteId) : undefined;
        if (
          control &&
          (!control.paused || control.current || control.gateStartedAt || control.editing)
        )
          return reply
            .code(409)
            .send({ error: 'Pause the sequence and wait for the current step to finish.' });
        if (control) {
          control.editing = true;
          editingReserved = true;
        }
        const body = req.body as Record<string, unknown>;
        if (!body || body.revision !== parameterRevision(c))
          return reply.code(409).send({ error: 'Campaign changed; reload its parameters.' });
        const caps = clampToCeiling(await store.getLimits());
        const input = parameterInput(c, body, caps);
        delete input.drsDocument;
        const validated = createCampaign(input, await effectiveAllowlist(), agentChoices(), caps);
        const updated: Campaign = {
          ...c,
          maxRps: validated.maxRps,
          concurrency: validated.concurrency,
          maxDurationSec: validated.maxDurationSec,
          scenario: validated.scenario,
          createdBy: req.authUser?.email ?? 'dev',
          status: 'PENDING_APPROVAL',
          approvedBy: undefined,
          approvalReason: undefined,
          approvalExpiresAt: undefined,
          cisoApprovedBy: undefined,
          cisoApprovedAt: undefined,
          statusDetail: 'Parameters changed; approval required.',
        };
        const saved = await store.transaction(async (tx) => {
          const fresh = await tx.getCampaign(id);
          if (!fresh || parameterRevision(fresh) !== body.revision) return false;
          if (control?.cancelled) return false;
          await tx.saveCampaign(updated);
          await tx.saveAudit({
            id: randomUUID(),
            at: new Date().toISOString(),
            actor: req.authUser?.email ?? 'dev',
            action: 'campaign.update',
            campaignId: id,
            detail: JSON.stringify({
              before: {
                maxRps: c.maxRps,
                concurrency: c.concurrency,
                maxDurationSec: c.maxDurationSec,
                scenario: c.scenario,
              },
              after: {
                maxRps: updated.maxRps,
                concurrency: updated.concurrency,
                maxDurationSec: updated.maxDurationSec,
                scenario: updated.scenario,
              },
            }),
          });
          return true;
        });
        if (!saved)
          return reply.code(409).send({ error: 'Campaign changed; reload its parameters.' });
        return updated;
      } catch (err) {
        return fail(err, reply);
      } finally {
        parameterEdits.delete(id);
        if (control && editingReserved) control.editing = false;
      }
    },
  );

  app.post('/api/suites/:id/run', { preHandler: guard('campaign:execute') }, async (req, reply) => {
    const runOptions = req.body as { pauseBetweenSteps?: unknown } | undefined;
    if (
      runOptions?.pauseBetweenSteps !== undefined &&
      typeof runOptions.pauseBetweenSteps !== 'boolean'
    )
      return reply.code(400).send({ error: 'pauseBetweenSteps must be a boolean.' });
    const suiteId = (req.params as { id: string }).id;
    const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
    if (members.length === 0) return reply.code(404).send({ error: 'suite not found' });
    if (members.some((m) => parameterEdits.has(m.id)))
      return reply.code(409).send({ error: 'Campaign parameters are being updated.' });
    const ctrl = reserveSuiteRun(suiteId);
    if (!ctrl) {
      return reply.code(409).send({ error: 'this suite sequence is already running' });
    }
    ctrl.total = members.length;
    let dispatched = false;
    try {
      const pending = members.filter((m) => m.status === 'PENDING_APPROVAL').length;
      if (adminConfirmation(req)) {
        if ((req.body as { confirmed?: unknown } | undefined)?.confirmed !== true) {
          return reply.code(400).send({
            error: 'Explicit assessment confirmation is required.',
            code: 'confirmation_required',
          });
        }
        // Validate every runnable step before changing any campaign state.
        try {
          for (const m of members) {
            if (m.status === 'PENDING_APPROVAL' || m.status === 'APPROVED') {
              const executionInput = { ...m };
              delete executionInput.drsDocument;
              createCampaign(
                executionInput,
                await effectiveAllowlist(),
                agentChoices(),
                effectiveCaps,
              );
              if (m.status === 'APPROVED') assertExecutable(m);
            }
          }
        } catch (err) {
          return fail(err, reply);
        }
      }
      if (!adminConfirmation(req) && pending > 0) {
        return reply.code(409).send({
          error: `approve the scenario first — ${pending} step(s) await CISO approval`,
        });
      }
      // The reserved sequence also prevents edits throughout validation and confirmation.
      ctrl.pauseBetweenSteps =
        (req.body as { pauseBetweenSteps?: unknown } | undefined)?.pauseBetweenSteps === true;
      if (adminConfirmation(req)) {
        try {
          for (const m of members) {
            if (m.status === 'PENDING_APPROVAL') {
              await store.saveCampaign(
                approveCampaign(
                  m,
                  req.authUser!.email,
                  'APPROVED',
                  'Single-user assessment confirmation',
                  { singleUser: adminConfirmation(req) },
                ),
              );
            }
          }
          await audit(
            req,
            'campaign.confirm',
            undefined,
            `Assessment ${suiteId}: ${members.length} steps confirmed`,
          );
        } catch (err) {
          suiteRuns.delete(suiteId);
          return fail(err, reply);
        }
      }
      const actor = req.authUser?.email ?? 'dev';
      try {
        await audit(req, 'suite.run', undefined, `sequence start · ${members.length} steps`);
      } catch (err) {
        suiteRuns.delete(suiteId);
        throw err;
      }
      // Do not await — the whole sequence can run for many minutes.
      dispatched = true;
      void runSuiteSequence(suiteId, actor, ctrl);
      return reply.code(202).send({ suiteId, steps: members.length, started: true });
    } finally {
      if (!dispatched) suiteRuns.delete(suiteId);
    }
  });

  // Live state of the in-flight suite sequences (for the UI's pause/cancel
  // controls). Only sequences currently running appear here.
  app.get('/api/suites/sequences', { preHandler: guard('campaign:read') }, async () => {
    const sequences: Record<
      string,
      {
        paused: boolean;
        pauseBetweenSteps?: boolean;
        current?: string;
        started: number;
        total: number;
        autoPaused?: boolean;
        downSkips: number;
        gateStartedAt?: number;
        gateMaxWaitMs?: number;
      }
    > = {};
    for (const [sid, ctrl] of suiteRuns) {
      sequences[sid] = {
        paused: ctrl.paused,
        pauseBetweenSteps: ctrl.pauseBetweenSteps,
        current: ctrl.current,
        started: ctrl.started,
        total: ctrl.total,
        autoPaused: ctrl.autoPaused,
        downSkips: ctrl.downSkips,
        gateStartedAt: ctrl.gateStartedAt,
        gateMaxWaitMs: ctrl.gateMaxWaitMs,
      };
    }
    return { sequences };
  });

  // Pause a running sequence: the current step finishes, the next does not
  // start until resumed. No effect on a step already in flight.
  app.post(
    '/api/suites/:id/pause',
    // Whoever can kill a run can control the sequence — the engineer who launched
    // it (two-step flow), a CISO, or an admin. Not gated behind approve alone.
    { preHandler: guard('campaign:kill') },
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
  app.post('/api/suites/:id/resume', { preHandler: guard('campaign:kill') }, async (req, reply) => {
    const suiteId = (req.params as { id: string }).id;
    const ctrl = suiteRuns.get(suiteId);
    if (!ctrl) return reply.code(404).send({ error: 'no running sequence for this suite' });
    if (ctrl.editing)
      return reply
        .code(409)
        .send({ error: 'Wait for the current step or parameter update to finish.' });
    ctrl.editing = true;
    try {
      const members = (await store.listCampaigns()).filter((c) => c.suiteId === suiteId);
      const pending = members.filter((c) => c.status === 'PENDING_APPROVAL');
      if (pending.length) {
        if (!adminConfirmation(req))
          return reply.code(409).send({ error: 'Approve modified steps before resuming.' });
        if ((req.body as { confirmed?: boolean } | undefined)?.confirmed !== true)
          return reply
            .code(400)
            .send({ error: 'Confirm the modified step parameters before resuming.' });
        const reviewed = (req.body as { reviewedSteps?: unknown }).reviewedSteps;
        if (
          !Array.isArray(reviewed) ||
          reviewed.length !== pending.length ||
          pending.some(
            (c) =>
              !reviewed.some(
                (budget) => JSON.stringify(budget) === JSON.stringify(parameterBudget(c)),
              ),
          )
        )
          return reply
            .code(409)
            .send({ error: 'Step parameters changed; review and confirm them again.' });
        try {
          for (const c of pending) {
            const input = { ...c };
            delete input.drsDocument;
            createCampaign(input, await effectiveAllowlist(), agentChoices(), effectiveCaps);
          }
          await store.transaction(async (tx) => {
            for (const c of pending) {
              const fresh = await tx.getCampaign(c.id);
              if (ctrl.cancelled || !fresh || parameterRevision(fresh) !== parameterRevision(c))
                throw new CampaignError('Campaign changed; review the steps again.');
              await tx.saveCampaign(
                approveCampaign(fresh, req.authUser!.email, 'APPROVED', 'Modified step confirmed', {
                  singleUser: true,
                }),
              );
              await tx.saveAudit({
                id: randomUUID(),
                at: new Date().toISOString(),
                actor: req.authUser!.email,
                action: 'campaign.confirm',
                campaignId: c.id,
                detail: `Modified step confirmed · ${parameterRevision(c)}`,
              });
            }
          });
        } catch (err) {
          return fail(err, reply);
        }
      }
      if (ctrl.cancelled) return reply.code(409).send({ error: 'Sequence cancelled.' });
      ctrl.paused = false;
      ctrl.autoPaused = false;
      ctrl.downSkips = 0;
      await audit(req, 'suite.resume', undefined, `sequence resumed · ${suiteId}`);
      return reply.send({ suiteId, paused: false });
    } finally {
      ctrl.editing = false;
    }
  });

  // Cancel a running sequence: stop before the next step and kill the step in
  // flight (its kill switch fires — a KILLED_MANUAL terminal state). Steps not
  // yet started are left as-is (approved but not run).
  app.post('/api/suites/:id/cancel', { preHandler: guard('campaign:kill') }, async (req, reply) => {
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
  });

  app.get('/api/campaigns/:id/stream', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await readTokenAllowed(req)))
      return reply.code(401).send({ error: 'authentication required' });
    reply.hijack();
    const res = reply.raw;
    readStreams.add(res);
    res.once('close', () => readStreams.delete(res));
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj: unknown) => {
      if (res.writableEnded || res.destroyed) return false;
      if (res.writableLength > 64 * 1024) {
        res.end();
        return false;
      }
      return res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
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
      try {
        if (!(await readTokenAllowed(req))) {
          clearInterval(timer);
          res.end();
          return;
        }
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
      } catch {
        clearInterval(timer);
        res.end();
      }
    }, 1000);
    res.on('close', () => clearInterval(timer));
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

  registerReadRoutes(app, {
    store,
    guard,
    readTokenAllowed,
    prometheusUrl: opts.prometheusUrl,
    grafanaUrl: opts.grafanaUrl,
  });

  // Conversational assistant (read-only bridge to an OpenAI-compatible LLM).
  // Fail-soft: no ASSISTANT_ENDPOINT configured → the routes report
  // `configured:false` and the chat endpoint returns 503 rather than failing.
  // When a RunPod pod id is configured (but no explicit endpoint), the endpoint
  // is derived from the pod's stable proxy URL so the UI power button and the
  // chat target stay in sync without any reconfiguration.
  const runpod = runpodConfigFromEnv();
  const assistantConfig = assistantConfigFromEnv();
  if (!assistantConfig.endpoint) assistantConfig.endpoint = podProxyEndpoint(runpod);
  // Live platform context injected into the assistant's system prompt so it can
  // answer about real state (authorized targets, recent campaigns, caps). Bounded
  // and read-only; failures never block the chat.
  const buildAssistantContext = async (): Promise<string> => {
    const [campaigns, runs, allowed] = await Promise.all([
      store.listCampaigns(),
      store.listRuns(),
      effectiveAllowlist(),
    ]);
    const bi = getBuildInfo();
    const caps = effectiveCaps;
    const lines: string[] = [];
    lines.push('=== LIVE PLATFORM CONTEXT (read-only, current server state) ===');
    lines.push(`Build: v${bi.version}+${bi.build} (${bi.commit}). Storage: ${store.backend}.`);
    lines.push(
      `Operational caps ENFORCED now: maxRps ${caps.maxRps}, maxConcurrency ${caps.maxConcurrency}, ` +
        `maxDurationSec ${caps.maxDurationSec} (immutable ceiling ` +
        `${HARD_CAPS.maxRps}/${HARD_CAPS.maxConcurrency}/${HARD_CAPS.maxDurationSec}).`,
    );
    lines.push(
      allowed.length
        ? `Authorized targets (${allowed.length}): ${allowed.slice(0, 40).join(', ')}` +
            (allowed.length > 40 ? ', …' : '') +
            '.'
        : 'Authorized targets: none registered/authorized.',
    );
    const recent = [...campaigns]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, 8);
    if (recent.length) {
      lines.push(`Recent campaigns (${recent.length} of ${campaigns.length}):`);
      for (const c of recent) {
        const latestRun = assistantLatestRun(runs, c.id);
        const wrs = ` · ${assistantMeasurementSummary(latestRun)}`;
        lines.push(`- Campaign ${c.id} · ${c.status} · ${assistantTargetOrigin(c.target)}${wrs}`);
      }
    } else {
      lines.push('Recent campaigns: none.');
    }
    try {
      const alerts = deriveAlerts(runs, campaigns, { limit: 5 });
      if (alerts.length) {
        lines.push(`Active alerts (${alerts.length}):`);
        for (const a of alerts.slice(0, 5)) lines.push(`- [${a.severity}] Signal ${a.kind}`);
      }
    } catch {
      /* alerts are best-effort */
    }
    lines.push(
      'Use this context to answer questions about the current platform state; do not invent data ' +
        'beyond it. When proposing an action, only use authorized targets and keep bounds within the ' +
        'enforced caps.',
    );
    lines.push(
      singleUser
        ? 'User mode: single administrator. Campaign execution requires explicit operator confirmation; there is no separate CISO approval.'
        : 'User mode: team; separation of duties applies.',
    );
    return lines.join('\n');
  };

  registerAssistantRoutes(app, {
    tokenBudget: opts.assistantTokenBudget,
    guard,
    config: assistantConfig,
    runpod,
    audit: (req, action, detail) => audit(req, action, undefined, detail),
    assistantContext: () => buildAssistantContext(),
    proposalPolicy: async () => ({
      allowedHosts: await effectiveAllowlist(),
      caps: clampToCeiling(await store.getLimits()),
      userMode: singleUser ? 'single' : 'team',
    }),
  });

  // Protected-target onboarding (governed). Registering a target is metadata
  // only; a CISO authorization adds the host to the effective allowlist above.
  registerTargetRoutes(app, {
    store,
    guard,
    audit: (req, action, detail) => audit(req, action, undefined, detail),
    envAllowlist: allowedTargets,
    actorOf: (req) => req.authUser?.email ?? 'dev',
    selfAuthorize: adminConfirmation,
  });

  return { app, runCampaign };
}
