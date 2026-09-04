export interface Campaign {
  id: string;
  name: string;
  target: string;
  vector: string;
  status: string;
  createdBy: string;
  approvedBy?: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  wrs?: { wrs: number; level: string };
  runId?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch('/health').then((r) => json<{ status: string; allowedTargets: string[] }>(r)),
  listCampaigns: () => fetch('/api/campaigns').then((r) => json<Campaign[]>(r)),
  createCampaign: (body: unknown) =>
    fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Campaign>(r)),
  approve: (id: string, body: unknown) =>
    fetch(`/api/campaigns/${id}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Campaign>(r)),
  execute: (id: string) =>
    fetch(`/api/campaigns/${id}/execute`, { method: 'POST' }).then((r) => json<unknown>(r)),
  kill: (id: string) => fetch(`/api/campaigns/${id}/kill`, { method: 'POST' }).then((r) => json(r)),
};
