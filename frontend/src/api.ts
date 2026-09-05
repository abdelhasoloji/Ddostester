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

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return fetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => json<T>(r));
}

export const api = {
  health: () => fetch('/health').then((r) => json<{ status: string; allowedTargets: string[] }>(r)),
  listCampaigns: () => fetch('/api/campaigns').then((r) => json<Campaign[]>(r)),
  createCampaign: (body: unknown) => post<Campaign>('/api/campaigns', body),
  approve: (id: string, body: unknown) => post<Campaign>(`/api/campaigns/${id}/approval`, body),
  execute: (id: string) => post<CampaignRun>(`/api/campaigns/${id}/execute`),
  kill: (id: string) => post<{ status: string }>(`/api/campaigns/${id}/kill`),
  getRun: (runId: string) => fetch(`/api/runs/${runId}`).then((r) => json<CampaignRun>(r)),
};
