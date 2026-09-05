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
  wrs?: WrsBreakdown;
  runId?: string;
}

export interface CampaignRun {
  runId: string;
  campaignId: string;
  status: CampaignStatus;
  generator: {
    totalRequests: number;
    successful: number;
    failed: number;
    actualRps: number;
    latencyMs: { min: number; max: number; mean: number; p50: number; p95: number; p99: number };
    statusCounts: Record<string, number>;
    errors: Record<string, number>;
  };
  probe: {
    samples: number;
    available: number;
    errorRate5xx: number;
    latencyMs: { p50: number; p95: number; p99: number };
    successful: number;
  };
  wrs: WrsBreakdown;
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

/** URL du rapport pour un lien navigateur (token en query si auth activée). */
export function reportUrl(runId: string): string {
  const u = `/api/runs/${runId}/report`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL du rapport de conformité agrégé (DORA/NIS2). */
export function complianceUrl(): string {
  const u = `/api/reports/compliance`;
  return token ? `${u}?token=${encodeURIComponent(token)}` : u;
}

/** URL du flux SSE de progression temps réel d'une campagne (EventSource). */
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
}

export const api = {
  health: () =>
    fetch('/health').then((r) =>
      json<{ status: string; allowedTargets: string[]; storage: string; authRequired: boolean }>(r),
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
  wrsHistory: () => get<WrsSeries[]>('/api/wrs/history'),
};
