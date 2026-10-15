import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, setToken } from './api.js';
const fetcher = vi.fn();
beforeEach(() => {
  setToken('fixture-bearer');
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(
    async () =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
});
afterEach(() => {
  setToken(null);
  vi.unstubAllGlobals();
});
it('keeps campaign and action IDs in single path segments and binds writes to an explicit revision', async () => {
  const id = 'campaign/../other?mode=measured';
  const evidence = Object.freeze({
    revisionId: 'frozen-two',
    evidence: { provenance: 'collector-import' },
  });
  await api.drsAction(id, 'evidence/../finalize', evidence);
  const [path, init] = fetcher.mock.calls[0];
  expect(path).toBe(
    `/api/campaigns/${encodeURIComponent(id)}/drs/${encodeURIComponent('evidence/../finalize')}`,
  );
  expect(init.headers.authorization).toBe('Bearer fixture-bearer');
  expect(JSON.parse(init.body)).toEqual(evidence);
  await api.drsCampaign(id);
  await api.drsReport(id, 2);
  await api.fleetEvidenceForCampaign(id);
  await api.fleetCampaign(id);
  await api.stopFleetMission(id);
  for (const [path] of fetcher.mock.calls) expect(path).toContain(encodeURIComponent(id));
});
it('encodes site/search separately and never changes the selected registry page or device identity', async () => {
  await api.fleetDevices({
    page: 2,
    pageSize: 100,
    siteId: 'site&search=other',
    search: 'camera?siteId=wrong',
  });
  const query = new URL(fetcher.mock.calls[0][0], 'http://localhost').searchParams;
  expect(query.get('siteId')).toBe('site&search=other');
  expect(query.get('search')).toBe('camera?siteId=wrong');
  expect(query.get('page')).toBe('2');
  expect(query.getAll('siteId')).toHaveLength(1);
  const input = Object.freeze({
    agentId: 'fixture',
    name: 'Sensor',
    siteId: 'site-a',
    group: 'Lab',
    privateIp: '10.1.1.1',
    profile: 'sensor' as const,
    notes: '',
  });
  const id = 'device/../other';
  await api.saveFleetDevice(input);
  await api.saveFleetDevice(input, id);
  await api.enrollFleetDevice(id);
  await api.revokeFleetDevice(id);
  await api.removeFleetDevice(id);
  const mutationCalls = fetcher.mock.calls.slice(1);
  expect(JSON.parse(mutationCalls[0][1].body)).toEqual(input);
  expect(JSON.parse(mutationCalls[1][1].body)).toEqual(input);
  for (const [path] of mutationCalls.slice(1)) expect(path).toContain(encodeURIComponent(id));
  expect(input.siteId).toBe('site-a');
});
it('surfaces revision conflicts instead of returning a successful evidence response', async () => {
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Stale revision' }), { status: 409 }),
  );
  await expect(
    api.drsAction('fixture', 'evidence', { revisionId: 'old', evidence: {} }),
  ).rejects.toThrow('Stale revision');
  expect(fetcher).toHaveBeenCalledOnce();
});
