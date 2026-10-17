import type { InfrastructureRevision } from '../modules/infrastructure/model.js';
import type { Campaign } from '../modules/campaigns/model.js';
import type { CampaignRun } from '../modules/campaigns/runner.js';
import type { AuditEntry } from '../modules/audit/model.js';
import { AUDIT_GENESIS, chainEntry } from '../modules/audit/integrity.js';
import type { User } from '../auth/users.js';
import { withCanonicalRole } from '../auth/rbac.js';
import type { Playbook } from '../modules/playbooks/playbooks.js';
import type { OperationalLimits } from '../config/limits.js';
import type { BenchRun, BenchVerdict, BenchCoverage } from '../modules/bench/model.js';
import type { ProtectedTarget } from '../modules/targets/model.js';
import type { Store, AccountPolicy, UserTransaction } from './types.js';
import type { FleetDevice } from '../modules/fleet/devices.js';

export class MemoryStore implements Store {
  private infrastructure = new Map<string, InfrastructureRevision>();
  async listInfrastructure(
    kind: InfrastructureRevision['kind'],
  ): Promise<InfrastructureRevision[]> {
    const latest = new Map<string, InfrastructureRevision>();
    for (const record of this.infrastructure.values())
      if (record.kind === kind && record.revision > (latest.get(record.id)?.revision ?? 0))
        latest.set(record.id, record);
    return structuredClone([...latest.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }
  async infrastructureHistory(
    kind: InfrastructureRevision['kind'],
    id: string,
  ): Promise<InfrastructureRevision[]> {
    return structuredClone(
      [...this.infrastructure.values()]
        .filter((r) => r.kind === kind && r.id === id)
        .sort((a, b) => a.revision - b.revision),
    );
  }
  async appendInfrastructure(record: InfrastructureRevision): Promise<void> {
    const key = `${record.kind}/${record.id}/${record.revision}`;
    if (this.infrastructure.has(key)) throw new Error('Duplicate infrastructure revision');
    this.infrastructure.set(key, structuredClone(record));
  }
  private fleetDevices = new Map<string, FleetDevice>();
  async getFleetDevice(id: string): Promise<FleetDevice | undefined> {
    const device = this.fleetDevices.get(id);
    return device ? structuredClone(device) : undefined;
  }
  async listFleetDevices(): Promise<FleetDevice[]> {
    return structuredClone([...this.fleetDevices.values()]);
  }
  async saveFleetDevice(device: FleetDevice): Promise<void> {
    this.fleetDevices.set(device.id, structuredClone(device));
  }
  async deleteFleetDevice(id: string): Promise<void> {
    this.fleetDevices.delete(id);
  }
  readonly backend = 'memory' as const;
  private campaigns = new Map<string, Campaign>();
  private runs = new Map<string, CampaignRun>();
  private audit: AuditEntry[] = [];
  private users = new Map<string, User>();
  private accountPolicy: AccountPolicy | undefined;
  private transactional = false;
  private userLock: Promise<void> = Promise.resolve();
  private playbooks = new Map<string, Playbook>();
  private targets = new Map<string, ProtectedTarget>();
  private limits: OperationalLimits | undefined;
  private benchRuns = new Map<string, BenchRun>();
  private benchCoverage: BenchCoverage[] = [];

  async init(): Promise<void> {}
  async acquireRuntimeLease(): Promise<boolean> {
    return true;
  }
  async healthy(): Promise<boolean> {
    return true;
  }
  async pruneOldData(
    olderThanDays: number,
  ): Promise<{ runs: number; audit: number; samples: number }> {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    let runs = 0;
    for (const [id, r] of this.runs) {
      const at = Date.parse(r.generator.finishedAt);
      if (Number.isFinite(at) && at < cutoff) {
        this.runs.delete(id);
        runs++;
      }
    }
    const before = this.audit.length;
    this.audit = this.audit.filter((e) => Date.parse(e.at) >= cutoff);
    return { runs, audit: before - this.audit.length, samples: 0 };
  }
  async saveCampaign(c: Campaign): Promise<void> {
    this.campaigns.set(c.id, c);
  }
  async getCampaign(id: string): Promise<Campaign | undefined> {
    return this.campaigns.get(id);
  }
  async listCampaigns(): Promise<Campaign[]> {
    return [...this.campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async deleteCampaigns(ids: string[]): Promise<number> {
    const set = new Set(ids);
    let removed = 0;
    for (const id of set) if (this.campaigns.delete(id)) removed++;
    // Cascade: drop the runs of the removed campaigns.
    for (const [runId, r] of this.runs) if (set.has(r.campaignId)) this.runs.delete(runId);
    return removed;
  }
  async saveRun(r: CampaignRun): Promise<void> {
    this.runs.set(r.runId, r);
  }
  async getRun(runId: string): Promise<CampaignRun | undefined> {
    return this.runs.get(runId);
  }
  async listRuns(campaignId?: string): Promise<CampaignRun[]> {
    return [...this.runs.values()]
      .reverse()
      .filter((r) => !campaignId || r.campaignId === campaignId);
  }
  async saveAudit(e: AuditEntry): Promise<void> {
    if (!this.transactional) return this.transaction((tx) => tx.saveAudit(e));
    const prev = this.audit.length
      ? (this.audit[this.audit.length - 1].hash ?? AUDIT_GENESIS)
      : AUDIT_GENESIS;
    this.audit.push(chainEntry(e, prev));
  }
  async listAudit(limit = 200): Promise<AuditEntry[]> {
    return [...this.audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
  async listAuditChain(): Promise<AuditEntry[]> {
    return [...this.audit];
  }
  async listUsers(): Promise<User[]> {
    // Canonicalise each role on read (legacy `officer` → `admin`), matching the
    // postgres store so both behave identically.
    return [...this.users.values()]
      .map(withCanonicalRole)
      .filter((u): u is User => u !== undefined)
      .sort((a, b) => a.email.localeCompare(b.email));
  }
  async getUser(email: string): Promise<User | undefined> {
    const u = this.users.get(email.toLowerCase());
    return u ? withCanonicalRole(u) : undefined;
  }
  async getAccountPolicy(): Promise<AccountPolicy | undefined> {
    return this.accountPolicy ? { ...this.accountPolicy } : undefined;
  }
  async setAccountPolicy(policy: AccountPolicy): Promise<void> {
    this.accountPolicy = { ...policy };
  }
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.transactional) return fn(this);
    const previous = this.userLock;
    let release!: () => void;
    this.userLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const tx = Object.create(this) as MemoryStore;
    tx.transactional = true;
    for (const key of [
      'campaigns',
      'fleetDevices',
      'infrastructure',
      'runs',
      'audit',
      'users',
      'accountPolicy',
      'playbooks',
      'targets',
      'limits',
      'benchRuns',
      'benchCoverage',
    ] as const) {
      (tx as unknown as Record<string, unknown>)[key] = structuredClone(this[key]);
    }
    try {
      const result = await fn(tx);
      for (const key of [
        'campaigns',
        'fleetDevices',
        'infrastructure',
        'runs',
        'audit',
        'users',
        'accountPolicy',
        'playbooks',
        'targets',
        'limits',
        'benchRuns',
        'benchCoverage',
      ] as const) {
        (this as unknown as Record<string, unknown>)[key] = tx[key];
      }
      return result;
    } finally {
      release();
    }
  }
  async transactionUsers<T>(fn: (tx: UserTransaction) => Promise<T>): Promise<T> {
    return this.transaction((tx) => fn(tx));
  }
  async saveUser(u: User): Promise<void> {
    this.users.set(u.email.toLowerCase(), u);
  }
  async saveUsersAtomically(users: User[]): Promise<void> {
    const next = new Map(this.users);
    for (const u of users) next.set(u.email.toLowerCase(), { ...u });
    this.users = next;
  }
  async deleteUser(email: string): Promise<void> {
    this.users.delete(email.toLowerCase());
  }
  async recordLogin(email: string, at: string): Promise<void> {
    const u = this.users.get(email.toLowerCase());
    if (u) this.users.set(email.toLowerCase(), { ...u, lastLoginAt: at });
  }
  async listPlaybooks(): Promise<Playbook[]> {
    return [...this.playbooks.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getPlaybook(id: string): Promise<Playbook | undefined> {
    return this.playbooks.get(id);
  }
  async savePlaybook(p: Playbook): Promise<void> {
    this.playbooks.set(p.id, p);
  }
  async deletePlaybook(id: string): Promise<void> {
    this.playbooks.delete(id);
  }
  async listTargets(): Promise<ProtectedTarget[]> {
    return [...this.targets.values()].sort((a, b) => a.host.localeCompare(b.host));
  }
  async getTarget(id: string): Promise<ProtectedTarget | undefined> {
    return this.targets.get(id);
  }
  async saveTarget(t: ProtectedTarget): Promise<void> {
    this.targets.set(t.id, t);
  }
  async deleteTarget(id: string): Promise<void> {
    this.targets.delete(id);
  }
  async getLimits(): Promise<OperationalLimits | undefined> {
    return this.limits ? { ...this.limits } : undefined;
  }
  async setLimits(limits: OperationalLimits): Promise<void> {
    this.limits = { ...limits };
  }
  async createBenchRun(run: BenchRun): Promise<void> {
    this.benchRuns.set(run.id, { ...run });
  }
  async getBenchRun(id: string): Promise<BenchRun | undefined> {
    const r = this.benchRuns.get(id);
    return r ? { ...r } : undefined;
  }
  async listBenchRuns(limit = 100, activeOnly = false): Promise<BenchRun[]> {
    return [...this.benchRuns.values()]
      .filter((r) => !activeOnly || r.status === 'REQUESTED' || r.status === 'CLAIMED')
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async claimNextBenchRun(runnerId: string): Promise<BenchRun | undefined> {
    // Oldest REQUESTED first (FIFO). Single-threaded event loop → atomic here.
    const next = [...this.benchRuns.values()]
      .filter((r) => r.status === 'REQUESTED')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
    if (!next) return undefined;
    next.status = 'CLAIMED';
    next.claimedAt = new Date().toISOString();
    next.claimedBy = runnerId;
    return { ...next };
  }
  async setBenchRunResult(
    id: string,
    result: { verdict?: BenchVerdict; error?: string },
  ): Promise<BenchRun | undefined> {
    const r = this.benchRuns.get(id);
    if (!r) return undefined;
    r.completedAt = new Date().toISOString();
    if (result.verdict) {
      r.status = 'COMPLETED';
      r.verdict = result.verdict;
    } else {
      r.status = 'FAILED';
      r.error = result.error ?? 'unknown error';
    }
    return { ...r };
  }
  async saveBenchCoverage(c: BenchCoverage): Promise<void> {
    this.benchCoverage.push({ ...c });
  }
  async listBenchCoverage(): Promise<BenchCoverage[]> {
    return [...this.benchCoverage].sort((a, b) => b.at.localeCompare(a.at)).map((c) => ({ ...c }));
  }
  async close(): Promise<void> {}
}
