import type { InfrastructureRevision } from '../modules/infrastructure/model.js';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import type { User } from '../auth/users.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { OperationalLimits } from '../config/limits.js';
import type { BenchRun, BenchVerdict, BenchCoverage } from '../modules/bench/model.js';
import type { ProtectedTarget } from '../modules/targets/model.js';
import type { FleetDevice } from '../modules/fleet/devices.js';

/**
 * Persistence layer. Two implementations: memory (dev/tests) and PostgreSQL
 * (production). Campaigns and runs are persisted; active kill switches (runtime
 * objects) live in a separate registry (runtime/kills).
 */
export interface AccountPolicy {
  schemaVersion: 1;
  primaryAdminEmail: string;
}
export type UserTransaction = Pick<
  Store,
  | 'listUsers'
  | 'getUser'
  | 'saveUser'
  | 'deleteUser'
  | 'saveAudit'
  | 'getAccountPolicy'
  | 'setAccountPolicy'
>;

export interface Store {
  listInfrastructure(kind: InfrastructureRevision['kind']): Promise<InfrastructureRevision[]>;
  infrastructureHistory(
    kind: InfrastructureRevision['kind'],
    id: string,
  ): Promise<InfrastructureRevision[]>;
  appendInfrastructure(record: InfrastructureRevision): Promise<void>;
  listFleetDevices(): Promise<FleetDevice[]>;
  getFleetDevice(id: string): Promise<FleetDevice | undefined>;
  saveFleetDevice(device: FleetDevice): Promise<void>;
  deleteFleetDevice(id: string): Promise<void>;
  readonly backend: 'memory' | 'postgres';
  init(): Promise<void>;
  /** Lightweight connectivity check for readiness probes. */
  healthy(): Promise<boolean>;
  acquireRuntimeLease(): Promise<boolean>;
  /**
   * Deletes runs, audit entries and WRS samples older than `olderThanDays`
   * (data retention). Campaigns are kept. Returns the number of rows removed.
   */
  pruneOldData(olderThanDays: number): Promise<{ runs: number; audit: number; samples: number }>;
  saveCampaign(c: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | undefined>;
  listCampaigns(): Promise<Campaign[]>;
  /**
   * Permanently deletes the given campaigns and their runs (admin purge). Returns
   * how many campaigns were removed. Never deletes the tamper-evident audit log.
   */
  deleteCampaigns(ids: string[]): Promise<number>;
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
  getAccountPolicy(): Promise<AccountPolicy | undefined>;
  setAccountPolicy(policy: AccountPolicy): Promise<void>;
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  transactionUsers<T>(fn: (tx: UserTransaction) => Promise<T>): Promise<T>;
  /** Atomic account migration; never deletes historical identities. */
  saveUsersAtomically(users: User[]): Promise<void>;
  deleteUser(email: string): Promise<void>;
  /** Records a successful login timestamp without touching credentials. */
  recordLogin(email: string, at: string): Promise<void>;
  /** User-defined assessment playbooks (additive to the curated ones). */
  listPlaybooks(): Promise<Playbook[]>;
  getPlaybook(id: string): Promise<Playbook | undefined>;
  savePlaybook(p: Playbook): Promise<void>;
  deletePlaybook(id: string): Promise<void>;
  /**
   * Protected targets (governed onboarding). Registering one is metadata only;
   * only those with `authStatus === 'authorized'` extend the effective allowlist.
   */
  listTargets(): Promise<ProtectedTarget[]>;
  getTarget(id: string): Promise<ProtectedTarget | undefined>;
  saveTarget(t: ProtectedTarget): Promise<void>;
  deleteTarget(id: string): Promise<void>;
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
