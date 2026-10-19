import { mutationActor, mutationSessionVersion } from '../store/audited.js';
import { can, canonicalRole } from '../auth/rbac.js';
import { clampToCeiling } from '../config/limits.js';
import { FLEET_LIMITS } from '../config/limits.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AttackAgent } from './types.js';
import { AgentError } from './types.js';
import { validateConfig, type LoadProgress } from '../engine/loadTest.js';
import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import { FleetCoordinator } from '../modules/fleet/coordinator.js';
import { createFleetExecutor, type FleetExecutor } from '../modules/fleet/executor.js';
import { localAgents, parseFleetSites } from '../modules/fleet/sites.js';
import { summarizeFleet } from '../modules/fleet/summary.js';
import { cleanupFleet } from '../modules/fleet/cleanup.js';
export class FleetHttpAgent implements AttackAgent {
  /**
   * The site that provides execution capacity. Defaults to the local in-cluster
   * executor; a remote site supplies its own implementation without touching
   * this class (M2.2).
   */
  constructor(private readonly executor?: FleetExecutor) {}

  readonly name = 'kubernetes-fleet';
  readonly multiPhase = false;
  readonly flowCapable = false;
  readonly endpointCapable = false;
  readonly correlationCapable = false;
  readonly description =
    'Closed lab fleet: three private sources, aggregate caps and autonomous leases; GET only.';
  async available(): Promise<boolean> {
    return (
      process.env.FLEET_ENABLED === '1' &&
      !!process.env.FLEET_SITES &&
      !!process.env.FLEET_LOCAL_SITE &&
      !!process.env.FLEET_AGENT_IMAGE &&
      !!process.env.DATABASE_URL &&
      !!process.env.KUBERNETES_SERVICE_HOST
    );
  }
  async run(
    config: LoadTestConfig,
    allowedHosts: string[],
    signal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult> {
    if (!(await this.available()))
      throw new AgentError('Fleet is not configured; no builtin fallback');
    validateConfig(config, allowedHosts);
    if (
      (config.method && config.method !== 'GET') ||
      config.body ||
      config.phases ||
      config.flow ||
      config.endpoints ||
      config.userAgents ||
      config.dataset ||
      config.assertion ||
      config.cacheBust ||
      config.noKeepAlive ||
      config.parallelism ||
      config.slowloris
    )
      throw new AgentError('Fleet MVP supports a plain bounded GET only');
    if (config.url !== 'http://lab-target:8080/health' && config.url !== 'http://lab-target:8080/')
      throw new AgentError('Fleet MVP requires the dedicated lab target');
    if (
      config.maxRps < FLEET_LIMITS.maxAgents ||
      config.maxRps > FLEET_LIMITS.maxRps ||
      config.concurrency < FLEET_LIMITS.maxAgents ||
      config.concurrency > FLEET_LIMITS.maxConcurrency ||
      config.durationSec < FLEET_LIMITS.minDurationSec ||
      config.durationSec > FLEET_LIMITS.maxDurationSec
    )
      throw new AgentError('Fleet MVP envelope: 3–15 RPS, 3–6 concurrent, 10–60 seconds');
    if (signal?.aborted) throw new AgentError('Fleet cancelled before preparation');
    const campaignId = config.headers?.['X-WEDOS-TEST']?.split(':')[0];
    if (!campaignId) throw new AgentError('Parent campaign identity is required');
    const actor = mutationActor.getStore();
    const sessionVersion = mutationSessionVersion.getStore();
    if (!actor || sessionVersion === undefined)
      throw new AgentError('Fleet requires an interactive authenticated managed account');
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
      query_timeout: 2500,
      statement_timeout: 2000,
      lock_timeout: 1500,
    });
    const coordinator = new FleetCoordinator(pool);
    const jobs = this.executor ?? createFleetExecutor(process.env);
    const names: string[] = [];
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const summarize = async (shards: Parameters<typeof summarizeFleet>[3]) => {
      const result = summarizeFleet(runId, config, startedAt, shards);
      result.fleet!.jobEvidence = await Promise.all(
        names.map(async (name) => {
          try {
            return { available: true, ...(await jobs.evidence(name)) };
          } catch {
            return { name, available: false };
          }
        }),
      );
      return result;
    };
    let stopping = false;
    let controlLost = false;
    let renewal: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const authorized = async () => {
      const result = await pool.query(
        'SELECT role,status,token_version FROM users WHERE email=$1',
        [actor.toLowerCase()],
      );
      const user = result.rows[0];
      const role = canonicalRole(user?.role);
      if (
        !user ||
        !role ||
        user.status !== 'active' ||
        Number(user.token_version) !== sessionVersion ||
        !can(role, 'campaign:execute')
      )
        return false;
      const settings = await pool.query('SELECT data FROM settings WHERE key=$1', [
        'operational_limits',
      ]);
      const caps = clampToCeiling(settings.rows[0]?.data);
      return (
        config.maxRps <= caps.maxRps &&
        config.concurrency <= caps.maxConcurrency &&
        config.durationSec <= caps.maxDurationSec
      );
    };
    try {
      if (!(await authorized()))
        throw new AgentError('Fleet operator session or current limits are invalid');
      await coordinator.init();
      const sites = parseFleetSites(process.env.FLEET_SITES ?? '');
      // Only this site's agents get a local job: a remote agent's shard belongs to
      // its resident worker, and racing it here would starve that site.
      const runnerAgents = localAgents(sites, process.env.FLEET_LOCAL_SITE ?? '');
      await coordinator.plan(
        {
          runId,
          campaignId,
          agentIds: sites.map((entry) => entry.agentId),
          sites,
          target: config.url,
          maxRps: config.maxRps,
          concurrency: config.concurrency,
          durationSec: config.durationSec,
        },
        {
          allowedHosts,
          allowedPorts: [8080],
          caps: {
            maxRps: FLEET_LIMITS.maxRps,
            maxConcurrency: FLEET_LIMITS.maxConcurrency,
            maxDurationSec: FLEET_LIMITS.maxDurationSec,
          },
        },
      );
      timer = setInterval(() => {
        if (renewal || stopping || controlLost) return;
        renewal = authorized()
          .then((allowed) => (allowed ? coordinator.renewControl(runId) : false))
          .then((ok) => {
            if (!ok) controlLost = true;
          })
          .catch(() => {
            controlLost = true;
          })
          .finally(() => {
            renewal = undefined;
          });
      }, FLEET_LIMITS.heartbeatMs);
      for (const { agentId } of runnerAgents) {
        if (signal?.aborted || controlLost) {
          stopping = true;
          await coordinator.stop(runId);
          break;
        }
        names.push(`fleet-${runId}-${agentId}`);
        await jobs.create(runId, agentId, config.durationSec);
      }
      const deadline = Date.now() + config.durationSec * 1000 + FLEET_LIMITS.stopTimeoutMs;
      while (Date.now() < deadline) {
        if ((signal?.aborted || controlLost) && !stopping) {
          stopping = true;
          await coordinator.stop(runId);
        }
        const snapshot = await coordinator.snapshot(runId);
        if (!snapshot) throw new AgentError('Fleet run disappeared');
        if (snapshot.state === 'SETTLED') return await summarize(snapshot.shards);
        const samples = snapshot.shards.map((s) => {
          const final = s.result?.generator as LoadTestResult | undefined;
          return final
            ? { sent: final.totalRequests, successful: final.successful, failed: final.failed }
            : (s.progress ?? { sent: 0, successful: 0, failed: 0 });
        });
        const elapsedSec = (Date.now() - Date.parse(startedAt)) / 1000;
        const sum = (key: 'sent' | 'successful' | 'failed') =>
          samples.reduce((n, p) => n + p[key], 0);
        onProgress?.({
          runId,
          sent: sum('sent'),
          successful: sum('successful'),
          failed: sum('failed'),
          elapsedSec,
          actualRps: elapsedSec > 0 ? sum('sent') / elapsedSec : 0,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await coordinator.stop(runId);
      const snapshot = await coordinator.snapshot(runId);
      return await summarize(snapshot?.shards ?? []);
    } finally {
      clearInterval(timer);
      await renewal;
      await cleanupFleet(
        runId,
        [
          { name: 'coordinator.stop', run: () => coordinator.stop(runId) },
          ...names.map((name) => ({ name: `job.delete:${name}`, run: () => jobs.remove(name) })),
          { name: 'kubernetes.close', run: () => jobs.close() },
          { name: 'database.close', run: () => pool.end() },
        ],
        (event) => console.warn(JSON.stringify(event)),
      );
    }
  }
}
