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
import {
  createCampaign,
  approveCampaign,
  cisoApproveCampaign,
  assertExecutable,
  cancelCampaign,
  transition,
  CampaignError,
} from './modules/campaigns/service.js';
import { executeCampaign } from './modules/campaigns/runner.js';
import { reArmRecurring } from './modules/campaigns/scheduler.js';
import type { CampaignRun } from './modules/campaigns/runner.js';
import type { Campaign, CampaignInput, CampaignStatus } from './modules/campaigns/model.js';
import { HARD_CAPS, clampToCeiling, withinCeiling } from './config/limits.js';
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
import { login, identityFromRequest } from './auth/guard.js';
import { signJwt } from './auth/jwt.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import { can } from './auth/rbac.js';
import type { Permission, Role } from './auth/rbac.js';
import {
  assertDelete,
  assertRoleChange,
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
import { noopTargetTelemetryProvider } from './modules/target-telemetry/provider.js';
import type { TargetTelemetryProvider } from './modules/target-telemetry/types.js';
import {
  PLAYBOOKS,
  getPlaybook,
  buildSuiteCampaigns,
  validatePlaybookInput,
  PlaybookError,
} from './modules/playbooks/playbooks.js';
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
  /** Notification sink (default: no-op — notifications are opt-in). */
  notifier?: Notifier;
  /** Protection integration for real detection/mitigation (default: no-op). */
  protection?: ProtectionProvider;
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

  // Security headers on every response (the app hardens itself, not just its
  // targets). No external origins are used, so the CSP is strict; 'unsafe-inline'
  // is limited to styles (the HTML reports embed a <style> block).
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self'",
    );
    return payload;
  });

  function guard(perm: Permission) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!auth.enabled) return;
      const id = identityFromRequest(auth, req);
      if (!id) return reply.code(401).send({ error: 'authentication required' });
      req.authUser = id;
      if (!can(id.role, perm)) return reply.code(403).send({ error: `missing ${perm} permission` });
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
    const onProgress = (p: LoadProgress) =>
      liveProgress.set(c.id, {
        ...p,
        maxDurationSec: c.maxDurationSec,
        status: 'RUNNING',
        engine: runAgent.name,
      });
    // Seed a zeroed progress record immediately: the run opens with a baseline
    // capture (awaited, a few seconds) during which the engine emits no
    // progress. Without this seed the live stream would find no record and tell
    // the UI the run is "done", stranding the progress view on "Starting run…".
    // Cleared in the finally below; onProgress overwrites it once load begins.
    onProgress({ sent: 0, successful: 0, failed: 0, elapsedSec: 0, actualRps: 0 });
    try {
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
      await store.saveRun(run);
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
        let host = c.target;
        try {
          host = new URL(c.target).hostname;
        } catch {
          /* keep raw */
        }
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
  }
  const suiteRuns = new Map<string, SuiteControl>();
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Reserve a suite's run slot synchronously (atomic guard). Returns null if a
   *  sequence is already registered for it — the caller must 409. Reserving
   *  before any `await` is what prevents a double-submit from starting two
   *  concurrent sequences (which would run two steps at once). */
  function reserveSuiteRun(suiteId: string): SuiteControl | null {
    if (suiteRuns.has(suiteId)) return null;
    const ctrl: SuiteControl = { paused: false, cancelled: false, total: 0, started: 0 };
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
    // Env-defined users first (unchanged path); then runtime store users.
    let res = login(auth, email, password);
    if (!res) {
      const su = await store.getUser(email.toLowerCase());
      if (su && verifyPassword(password, su.passwordHash)) {
        res = {
          token: signJwt({ sub: su.email, role: su.role }, auth.secret),
          email: su.email,
          role: su.role,
        };
      }
    }
    if (!res) {
      loginFails.set(key, { count: (entry?.count ?? 0) + 1, until: Date.now() + LOCK_MS });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    loginFails.delete(key);
    return res;
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

  app.get('/api/auth/me', { preHandler: guard('campaign:read') }, async (req) => {
    return req.authUser ?? { email: null, role: null, authRequired: false };
  });

  // --- User management (officer only; env users are immutable) ---------------
  const envUsers = (): { email: string; role: Role }[] =>
    [...auth.users.values()].map((u) => ({ email: u.email, role: u.role }));
  const envEmailSet = (): Set<string> => new Set([...auth.users.keys()]);
  /** Env-defined users merged with runtime store users (store role wins). */
  const currentUsers = async () => {
    const stored = (await store.listUsers()).map((u) => ({ email: u.email, role: u.role }));
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
      await store.saveUser({ email, role, passwordHash: hashPassword(body.password ?? '') });
      await audit(req, 'user.upsert', undefined, `${email} → ${role} (create)`);
      return reply.code(201).send({ email, role, source: 'store' });
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

  app.patch('/api/users/:email', { preHandler: guard('user:manage') }, async (req, reply) => {
    if (!auth.enabled) return reply.code(400).send({ error: 'authentication is disabled' });
    try {
      const raw = decodeURIComponent((req.params as { email: string }).email);
      const body = req.body as { role?: string };
      const current = await currentUsers();
      const { email, role } = assertRoleChange(raw, body.role ?? '', {
        envEmails: envEmailSet(),
        current,
        actorEmail: req.authUser?.email ?? '',
      });
      // Role-only change: preserve the existing password hash.
      const existing = await store.getUser(email);
      if (!existing) return reply.code(404).send({ error: 'user not found' });
      await store.saveUser({ ...existing, role });
      await audit(req, 'user.upsert', undefined, `${email} → ${role} (role change)`);
      return { email, role, source: 'store' };
    } catch (err) {
      if (err instanceof UserError) return reply.code(400).send({ error: err.message });
      return fail(err, reply);
    }
  });

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
        const inputs = buildSuiteCampaigns(
          pb,
          {
            target: body.target,
            probeUrl: body.probeUrl || body.target,
            createdBy: req.authUser?.email ?? 'dev',
            recurrenceMin: body.recurrenceMin,
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
          `playbook "${pb.name}" → ${created.length} campaigns (suite ${created[0]?.suiteId})`,
        );
        return reply.code(201).send({ suiteId: created[0]?.suiteId, campaigns: created });
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
      { paused: boolean; current?: string; started: number; total: number }
    > = {};
    for (const [sid, ctrl] of suiteRuns) {
      sequences[sid] = {
        paused: ctrl.paused,
        current: ctrl.current,
        started: ctrl.started,
        total: ctrl.total,
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
      if (!kill) return reply.code(404).send({ error: 'no run in progress' });
      kill.trigger('KILLED_MANUAL');
      await audit(req, 'campaign.kill', id);
      return { status: 'KILLED_MANUAL' };
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

  registerReadRoutes(app, { store, guard, readTokenAllowed });

  return { app, runCampaign };
}
