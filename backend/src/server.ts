import pg from 'pg';
import { PostgresTokenBudget } from './modules/assistant/token-budget.js';
import { FleetCoordinator } from './modules/fleet/coordinator.js';
import { stopAllProcesses } from './agents/proc.js';
import { createStore } from './store/index.js';
import { initAuth } from './auth/guard.js';
import { kills } from './runtime/kills.js';
import { reconcileOrphanedRuns } from './runtime/reconcile.js';
import { dueCampaigns } from './modules/campaigns/scheduler.js';
import { selectAgent } from './agents/index.js';
import { createNotifier, notifyConfigFromEnv } from './modules/notify/notifier.js';
import {
  createProtectionProvider,
  protectionConfigFromEnv,
} from './modules/protection/provider.js';
import {
  createTargetTelemetryProvider,
  targetTelemetryConfigFromEnv,
} from './modules/target-telemetry/provider.js';
import { buildApp } from './app.js';
import { applyTlsPolicy } from './util/tls.js';
import { decideBind } from './util/bind.js';

// New application launches use the DRS-only workflow; legacy is an explicit regression mode.
process.env.CAMPAIGN_CATALOG ??= 'drs-fleet';
if (!['drs-fleet', 'legacy'].includes(process.env.CAMPAIGN_CATALOG))
  throw new Error('Invalid CAMPAIGN_CATALOG');

// Apply the TLS policy before any outbound connection (store, fetch) is opened.
applyTlsPolicy((msg) => console.warn(`[tls] ${msg}`));

/** Reads a positive-integer env var, failing fast on an invalid value. */
function intEnv(name: string, def: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`Invalid ${name}="${raw}" — expected a positive integer.`);
  }
  return n;
}

const PORT = intEnv('PORT', 8080);
// Listen address. Default: loopback only — the tool must NEVER be exposed
// publicly without a TLS/mTLS reverse proxy. Bind a PRIVATE address (firewalled
// to the lab runner) to let VPS 2 claim jobs; a public/all-interfaces bind is
// refused unless ALLOW_PUBLIC_BIND=1. Remote UI access is via SSH tunnel.
const HOST = process.env.HOST ?? '127.0.0.1';
const bind = decideBind(HOST, process.env.ALLOW_PUBLIC_BIND === '1');
if (!bind.ok) {
  console.error(`[bind] ${bind.error}`);
  process.exit(1);
}
if (bind.warn) console.warn(`[bind] ${bind.warn}`);
const ALLOWED_TARGETS = (process.env.ALLOWED_TARGETS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (ALLOWED_TARGETS.length === 0) {
  throw new Error('ALLOWED_TARGETS must list at least one host.');
}
// Isolated lab targets for DRS validation (drs-validation-policy.md). Must not
// overlap ALLOWED_TARGETS — buildApp fails closed if they do.
const LAB_TARGETS = (process.env.LAB_TARGETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Bearer token an isolated bench runner presents to claim/complete governed
// class-C runs. Unset = governed dispatch disabled (fail-closed).
const BENCH_RUNNER_TOKEN = (process.env.BENCH_RUNNER_TOKEN ?? '').trim();
const SCHEDULER_INTERVAL_MS = intEnv('SCHEDULER_INTERVAL_MS', 30_000);
const RETENTION_DAYS = intEnv('RETENTION_DAYS', 90, true);
const MAX_CONCURRENT_RUNS = intEnv('MAX_CONCURRENT_RUNS', 3);

const store = await createStore();
if (!(await store.acquireRuntimeLease()))
  throw new Error(
    'Another control-plane runtime holds the database lease; only one replica is supported.',
  );
const auth = initAuth();
const SCHEDULER = auth.userMode !== 'single' && (process.env.SCHEDULER ?? 'on') !== 'off';
if (auth.userMode === 'single' && store.backend !== 'postgres') {
  throw new Error(
    'USER_MODE=single requires DATABASE_URL for persistent credentials and session revocation.',
  );
}
// Fail closed on a weak signing secret: HS256 with a short shared secret is
// offline-brute-forceable, which would let an attacker forge a token for any
// role. Enforced here (the real entrypoint) rather than in initAuth so unit
// tests can keep using tiny fixture secrets. Generate: `openssl rand -base64 48`.
if (auth.enabled && auth.secret.length < 32) {
  console.error(
    'FATAL: AUTH_JWT_SECRET must be at least 32 characters ' +
      '(generate one with `openssl rand -base64 48`).',
  );
  process.exit(1);
}
const agent = selectAgent();
const notifier = createNotifier(notifyConfigFromEnv());
const protection = createProtectionProvider(protectionConfigFromEnv());
const targetTelemetry = createTargetTelemetryProvider(targetTelemetryConfigFromEnv());
const assistantPool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  : undefined;
const assistantTokenBudget = assistantPool ? new PostgresTokenBudget(assistantPool) : undefined;
await assistantTokenBudget?.init();
const { app, runCampaign } = await buildApp({
  assistantTokenBudget,
  store,
  auth,
  allowedTargets: ALLOWED_TARGETS,
  labTargets: LAB_TARGETS,
  agent,
  notifier,
  protection,
  targetTelemetry,
  maxConcurrentRuns: MAX_CONCURRENT_RUNS,
  benchRunnerToken: BENCH_RUNNER_TOKEN || undefined,
  // Dual control: mandate a CISO sign-off on every campaign (the posture for a
  // networked/public deployment). Off by default (single-officer approval).
  requireCisoApproval: process.env.REQUIRE_CISO_APPROVAL === '1',
  prometheusUrl: process.env.PROMETHEUS_URL?.trim() || undefined,
  grafanaUrl: process.env.GRAFANA_URL?.trim() || undefined,
});

delete process.env.SINGLE_USER_PASSWORD;
const assistantRetention = assistantTokenBudget
  ? setInterval(
      () => {
        void assistantTokenBudget
          .prune()
          .catch((err) => app.log.error({ err }, 'assistant budget retention failed'));
      },
      24 * 3600 * 1000,
    )
  : undefined;
assistantRetention?.unref();
app.addHook('onClose', async () => {
  clearInterval(assistantRetention);
  await assistantPool?.end();
});

// The singleton lease is held before revoking interrupted distributed assignments.
if (process.env.FLEET_ENABLED === '1') {
  const fleetPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 2500,
    statement_timeout: 2000,
  });
  try {
    const coordinator = new FleetCoordinator(fleetPool);
    await coordinator.init();
    await coordinator.reconcile();
  } finally {
    await fleetPool.end();
  }
}

// --- Reconcile orphaned RUNNING campaigns -----------------------------------
// At boot the in-memory kill registry is empty, so any campaign the store still
// marks RUNNING was left by a previous process that died mid-run (a deploy
// restart, crash or OOM). That run is NOT in flight: it can never be killed or
// completed and would sit "stuck" forever — the kill/cancel endpoints 404
// because there is no live run to stop. Reset each back to APPROVED (re-runnable)
// with a note, mirroring runCampaign's own failure path, so operators can act on
// it again.
{
  const reset = await reconcileOrphanedRuns(store);
  if (reset > 0) {
    app.log.warn(
      `reconciled ${reset} orphaned RUNNING campaign(s) at startup (fleet cancelled; local runs returned to approval)`,
    );
  }
}

// --- Scheduler (CAM-01): runs due scheduled campaigns -----------------------
if (SCHEDULER) {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const campaigns = await store.listCampaigns();
      for (const c of dueCampaigns(campaigns, Date.now())) {
        if (kills.get(c.id)) continue; // already running
        app.log.info(`scheduler: running scheduled campaign ${c.id}`);
        try {
          await runCampaign(c, 'scheduler');
        } catch (err) {
          app.log.error({ err }, `scheduled run failed ${c.id}`);
        }
      }
    } catch (err) {
      app.log.error({ err }, 'scheduler tick failed');
    } finally {
      ticking = false;
    }
  }, SCHEDULER_INTERVAL_MS).unref();
}

// --- Data retention: prune old runs/audit/WRS samples once a day ------------
if (RETENTION_DAYS > 0) {
  const prune = async (): Promise<void> => {
    try {
      const removed = await store.pruneOldData(RETENTION_DAYS);
      if (removed.runs || removed.audit || removed.samples) {
        app.log.info(
          `retention: pruned ${removed.runs} runs, ${removed.audit} audit, ${removed.samples} samples (> ${RETENTION_DAYS}d)`,
        );
      }
    } catch (err) {
      app.log.error({ err }, 'retention prune failed');
    }
  };
  void prune();
  setInterval(() => void prune(), 24 * 3600 * 1000).unref();
}

// Graceful shutdown: closes the API then the store (DB connections) cleanly.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`shutting down (${signal})…`);
  try {
    kills.stopAll();
    await stopAllProcesses();
    await app.close();
    await store.close();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
  } finally {
    process.exit(0);
  }
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void shutdown(sig));
}

app
  .listen({ port: PORT, host: HOST })
  .then((addr) =>
    app.log.info(
      `ShieldTest control plane on ${addr} — storage: ${store.backend} — scheduler: ${SCHEDULER ? 'on' : 'off'} — notifications: ${notifier.sinks.length ? notifier.sinks.join('+') : 'off'} — targets: ${ALLOWED_TARGETS.join(', ')}`,
    ),
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
