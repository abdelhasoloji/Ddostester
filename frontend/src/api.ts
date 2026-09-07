export type CampaignStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'KILLED_AUTO'
  | 'KILLED_MANUAL';

export interface WrsBreakdown {
  detection: number;
  mitigation: number;
  availability: number;
  collateral: number;
  wrs: number;
  level: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
  estimated?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  target: string;
  probeUrl: string;
  vector: string;
  status: CampaignStatus;
  createdBy: string;
  approvedBy?: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  scheduledAt?: string;
  scenario?: { maxRps: number; durationSec: number }[];
  agent?: string;
  recurrence?: { intervalMin: number; until?: string };
  flow?: RequestStep[];
  endpoints?: WeightedEndpoint[];
  userAgents?: string[];
  dataset?: Record<string, string>[];
  acceptance?: AcceptanceCriteria;
  assertion?: ResponseAssertion;
  acceptanceResult?: AcceptanceResult;
  suiteId?: string;
  suiteName?: string;
  suiteOrder?: number;
  wrs?: WrsBreakdown;
  runId?: string;
  /** Why the latest run ended as it did (set for a kill), mirrored from the run. */
  statusDetail?: string;
}

export interface AcceptanceCriteria {
  maxP95Ms?: number;
  maxErrorRatePct?: number;
  minAvailabilityPct?: number;
  minWrs?: number;
  maxAssertionFailurePct?: number;
}

export interface ResponseAssertion {
  status?: number;
  bodyContains?: string;
}

export interface WeightedEndpoint {
  method?: string;
  url: string;
  body?: string;
  weight?: number;
}

export interface AcceptanceResult {
  verdict: 'PASS' | 'FAIL';
  failures: string[];
}

export interface ThreatInfo {
  technique: string;
  reference: string;
  measures: string;
  notReproduced: string;
}

export interface Playbook {
  id: string;
  name: string;
  category: string;
  summary: string;
  when: string;
  custom?: boolean;
  threat?: ThreatInfo;
  drsLevel?: number;
  steps: {
    name: string;
    summary: string;
    maxRps: number;
    concurrency: number;
    maxDurationSec: number;
    profile: string;
    vector?: string;
    agent?: string;
    paths?: string[];
    rotateUa?: boolean;
    headers?: Record<string, string>;
  }[];
}

export interface RequestStep {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  thinkMs?: number;
  name?: string;
  extract?: { name: string; from: 'json' | 'header' | 'regex'; expr: string };
}

export interface RunSample {
  t: number;
  rps: number;
  sent: number;
  failed: number;
  probe5xx: number;
  availPct: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  multiPhase: boolean;
  flowCapable: boolean;
  description: string;
}

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: CampaignStatus;
  /** Human-readable explanation of the terminal status (e.g. why an auto-kill fired). */
  statusDetail?: string;
  generator: {
    totalRequests: number;
    successful: number;
    failed: number;
    actualRps: number;
    latencyMs: { min: number; max: number; mean: number; p50: number; p95: number; p99: number };
    statusCounts: Record<string, number>;
    errors: Record<string, number>;
    assertionsChecked?: number;
    assertionFailures?: number;
  };
  probe: {
    samples: number;
    available: number;
    errorRate5xx: number;
    latencyMs: { p50: number; p95: number; p99: number };
    successful: number;
  };
  wrs: WrsBreakdown;
  acceptance?: AcceptanceResult;
  timeline?: RunSample[];
  protectionSource?: string;
  protection?: { source?: string; detectionTimeSec: number; mitigationTimeSec: number };
  baseline?: { samples: number; availabilityPct: number; latencyMs: { p50: number; p95: number } };
  baselineDelta?: {
    latencyP50DeltaMs: number;
    latencyP95DeltaMs: number;
    availabilityDeltaPct: number;
  };
  targetTelemetry?: {
    at: string;
    cpuPct?: number;
    conntrack?: number;
    nicRxMbps?: number;
    nicTxMbps?: number;
  }[];
  posture?: {
    waf: boolean;
    cdn: boolean;
    rateLimiting: boolean;
    loadBalancer: boolean;
    hsts: boolean;
    securityHeaders: string[];
    server?: string;
    signals: string[];
  };
}

export type Role = 'engineer' | 'officer' | 'viewer';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  campaignId?: string;
  detail?: string;
}

export interface AuditVerdict {
  ok: boolean;
  count: number;
  headHash: string;
  brokenAt?: { index: number; id: string; reason: 'content' | 'link' | 'missing-hash' };
}

export interface WrsPoint {
  at: string;
  wrs: number;
  level: string;
  runId: string;
}
export interface WrsSeries {
  target: string;
  points: WrsPoint[];
  regression: boolean;
  drop: number;
}

let token: string | null = localStorage.getItem('token');
export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}
export function getToken(): string | null {
  return token;
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return token ? { ...base, authorization: `Bearer ${token}` } : base;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new Error((data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

function get<T>(url: string): Promise<T> {
  return fetch(url, { headers: authHeaders() }).then((r) => json<T>(r));
}
function post<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}
function patch<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'PATCH',
    headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}
function del<T>(url: string): Promise<T> {
  return fetch(url, { method: 'DELETE', headers: authHeaders() }).then((r) => json<T>(r));
}

/** Report URL for a browser link (token in the query if auth is enabled). */
export function reportUrl(runId: string): string {
  const u = `/api/runs/${runId}/report`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** CSV export of all runs' aggregated metrics (token in the query if auth on). */
export function runsCsvUrl(): string {
  const u = `/api/runs.csv`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** CSV export of one run's per-second timeline. */
export function runTimelineCsvUrl(runId: string): string {
  const u = `/api/runs/${runId}/timeline.csv`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL of the downloadable, self-verifiable audit export (entries + hashes). */
export function auditExportUrl(): string {
  const u = `/api/audit/export`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL of the aggregated compliance report (DORA/NIS2). */
export function complianceUrl(): string {
  const u = `/api/reports/compliance`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL of the before/after comparison of two runs (token in the query if auth on). */
export function compareUrl(runIdA: string, runIdB: string): string {
  const q = `a=${encodeURIComponent(runIdA)}&b=${encodeURIComponent(runIdB)}`;
  const u = `/api/reports/compare?${q}`;
  return token ? `${u}&token=${encodeURIComponent(token)}` : u;
}

/** URL of an assessment suite's consolidated HTML report. */
export function suiteReportUrl(suiteId: string): string {
  const u = `/api/suites/${suiteId}/report`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL of a campaign's real-time progress SSE stream (EventSource). */
export function streamUrl(campaignId: string): string {
  const u = `/api/campaigns/${campaignId}/stream`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

export interface LiveProgressData {
  sent: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  actualRps: number;
  maxDurationSec: number;
  status: 'RUNNING';
  engine?: string;
  probe?: { samples: number; available: number; errorRate5xx: number };
}

/**
 * The server's HARD_CAPS, delivered by `/health`. The backend
 * (`backend/src/config/limits.ts`) is the single source of truth; the frontend
 * never hardcodes these — it displays whatever the server reports. `DEFAULT_CAPS`
 * is a pre-load fallback for inline hints only; the backend always enforces the
 * real caps regardless.
 */
export interface HardCaps {
  maxRps: number;
  maxConcurrency: number;
  maxDurationSec: number;
}
export const DEFAULT_CAPS: HardCaps = { maxRps: 2000, maxConcurrency: 500, maxDurationSec: 900 };

export const api = {
  health: () =>
    fetch('/health').then((r) =>
      json<{
        status: string;
        allowedTargets: string[];
        labTargets?: string[];
        storage: string;
        authRequired: boolean;
        agent?: string;
        notifications?: string[];
        protection?: boolean;
        tlsInsecure?: boolean;
        hardCaps?: HardCaps;
      }>(r),
    ),
  login: (email: string, password: string) =>
    post<{ token: string; email: string; role: Role }>('/api/auth/login', { email, password }),
  me: () => get<{ email: string | null; role: Role | null }>('/api/auth/me'),
  listCampaigns: () => get<Campaign[]>('/api/campaigns'),
  createCampaign: (body: unknown) => post<Campaign>('/api/campaigns', body),
  approve: (id: string, body: unknown) => post<Campaign>(`/api/campaigns/${id}/approval`, body),
  execute: (id: string) => post<CampaignRun>(`/api/campaigns/${id}/execute`),
  kill: (id: string) => post<{ status: string }>(`/api/campaigns/${id}/kill`),
  getRun: (runId: string) => get<CampaignRun>(`/api/runs/${runId}`),
  audit: (limit = 100) => get<AuditEntry[]>(`/api/audit?limit=${limit}`),
  verifyAudit: () => get<AuditVerdict>('/api/audit/verify'),
  wrsHistory: () => get<WrsSeries[]>('/api/wrs/history'),
  agents: () => get<{ default: string; agents: AgentInfo[] }>('/api/agents'),
  notifyTest: () => post<{ delivered: boolean; sinks: string[] }>('/api/notify/test'),
  createShare: (ttlMinutes?: number) =>
    post<{ authRequired: boolean; token: string | null; ttlMinutes?: number; expiresAt?: string }>(
      '/api/share',
      { ttlMinutes },
    ),
  listUsers: () => get<ManagedUser[]>('/api/users'),
  createUser: (body: { email: string; role: Role; password: string }) =>
    post<ManagedUser>('/api/users', body),
  updateUserRole: (email: string, role: Role) =>
    patch<ManagedUser>(`/api/users/${encodeURIComponent(email)}`, { role }),
  deleteUser: (email: string) =>
    del<{ deleted: string }>(`/api/users/${encodeURIComponent(email)}`),
  playbooks: () => get<Playbook[]>('/api/playbooks'),
  createPlaybook: (body: unknown) => post<Playbook>('/api/playbooks', body),
  deletePlaybook: (id: string) =>
    del<{ deleted: string }>(`/api/playbooks/${encodeURIComponent(id)}`),
  instantiatePlaybook: (
    id: string,
    body: { target: string; probeUrl?: string; recurrenceMin?: number },
  ) => post<{ suiteId: string; campaigns: Campaign[] }>(`/api/playbooks/${id}/instantiate`, body),
  suites: () => get<SuiteSummary[]>('/api/suites'),
};

export interface SuiteSummary {
  suiteId: string;
  suiteName: string;
  target: string;
  createdAt: string;
  total: number;
  pending: number;
  approved: number;
  running: number;
  completed: number;
  members: {
    id: string;
    name: string;
    order: number;
    status: CampaignStatus;
    wrs?: number;
    level?: WrsBreakdown['level'];
    verdict?: 'PASS' | 'FAIL';
    runId?: string;
  }[];
  wrs: { avg: number; min: number; level: WrsBreakdown['level']; scored: number } | null;
  verdict: 'PASS' | 'FAIL' | null;
}

export interface ManagedUser {
  email: string;
  role: Role;
  source: 'env' | 'store';
}
