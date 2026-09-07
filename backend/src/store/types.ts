import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { OperationalLimits } from '../config/limits.js';
import type { BenchRun, BenchVerdict, BenchCoverage } from '../modules/bench/model.js';

/**
 * Persistence layer. Two implementations: memory (dev/tests) and PostgreSQL
 * (production). Campaigns and runs are persisted; active kill switches (runtime
 * objects) live in a separate registry (runtime/kills).
 */
export interface Store {
  readonly backend: 'memory' | 'postgres';
  init(): Promise<void>;
  /** Lightweight connectivity check for readiness probes. */
  healthy(): Promise<boolean>;
  /**
   * Deletes runs, audit entries and WRS samples older than `olderThanDays`
   * (data retention). Campaigns are kept. Returns the number of rows removed.
   */
  pruneOldData(olderThanDays: number): Promise<{ runs: number; audit: number; samples: number }>;
  saveCampaign(c: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  listCampaigns(): Promise<Campaign[]>;
  saveRun(r: CampaignRun): Promise<void>;
  getRun(runId: string): Promise<CampaignRun | undefined>;
  /** Run history (all, or filtered by campaign), newest first. */
  listRuns(campaignId?: string): Promise<CampaignRun[]>;
  /**
   * Appends an audit entry, chaining it (prevHash/hash) onto the current head
   * for tamper-evidence. The store fills the chain fields; callers pass the
   * entry without them.
   */
  saveAudit(e: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;
  /** All audit entries oldest-first, in chain (write) order — for verify/export. */
  listAuditChain(): Promise<AuditEntry[]>;
  /**
   * Runtime-managed users (additive to the immutable env-defined AUTH_USERS,
   * which are never stored here). Officer-managed, audited.
   */
  listUsers(): Promise<User[]>;
  getUser(email: string): Promise<User | undefined>;
  saveUser(u: User): Promise<void>;
  deleteUser(email: string): Promise<void>;
  /** User-defined assessment playbooks (additive to the curated ones). */
  listPlaybooks(): Promise<Playbook[]>;
  getPlaybook(id: string): Promise<Playbook | undefined>;
  savePlaybook(p: Playbook): Promise<void>;
  deletePlaybook(id: string): Promise<void>;
  /**
   * CISO-managed operational limits (the effective caps, always ≤ the immutable
   * HARD_CAPS ceiling). `undefined` when never set — the effective caps then
   * default to the ceiling. The absolute ceiling is code-only and is never
   * stored or read from here.
   */
  getLimits(): Promise<OperationalLimits | undefined>;
  setLimits(limits: OperationalLimits): Promise<void>;
  /**
   * Governed class-C bench runs (record-and-dispatch). The control plane records
   * a request and serves it read-only; an isolated external runner claims it,
   * executes it OUTSIDE the control plane, and posts back a class-C verdict. No
   * amplification traffic is ever emitted from here.
   */
  createBenchRun(run: BenchRun): Promise<void>;
  getBenchRun(id: string): Promise<BenchRun | undefined>;
  listBenchRuns(limit?: number): Promise<BenchRun[]>;
  /** Atomically claim the oldest REQUESTED run for `runnerId` (→ CLAIMED). */
  claimNextBenchRun(runnerId: string): Promise<BenchRun | undefined>;
  /** Complete a CLAIMED run with a verdict (→ COMPLETED) or an error (→ FAILED). */
  setBenchRunResult(
    id: string,
    result: { verdict?: BenchVerdict; error?: string },
  ): Promise<BenchRun | undefined>;
  /**
   * Coverage evidence for a bench vector (any method other than an actual run):
   * ingested external verdicts, control attestations, modelled or replay
   * judgements. Read-only assurance — no traffic is ever emitted from here.
   */
  saveBenchCoverage(c: BenchCoverage): Promise<void>;
  listBenchCoverage(): Promise<BenchCoverage[]>;
  close(): Promise<void>;
}
