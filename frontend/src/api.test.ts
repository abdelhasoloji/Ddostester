import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const {
  api,
  setToken,
  getToken,
  reportUrl,
  runsCsvUrl,
  runTimelineCsvUrl,
  complianceUrl,
  suiteReportUrl,
  streamUrl,
  auditExportUrl,
} = await import('./api.js');

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): Mock {
  const fn = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'Status',
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
function lastCall(fn: Mock): [string, Record<string, unknown> | undefined] {
  return fn.mock.calls[fn.mock.calls.length - 1] as [string, Record<string, unknown> | undefined];
}

beforeEach(() => {
  setToken(null);
  localStorage.clear();
});

describe('token management', () => {
  it('stores and clears the token', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(localStorage.getItem('token')).toBe('abc');
    setToken(null);
    expect(getToken()).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });
});

describe('url builders', () => {
  it('omit the token when unauthenticated', () => {
    expect(reportUrl('r1')).toBe('/api/runs/r1/report');
    expect(runsCsvUrl()).toBe('/api/runs.csv');
    expect(runTimelineCsvUrl('r1')).toBe('/api/runs/r1/timeline.csv');
    expect(complianceUrl()).toBe('/api/reports/compliance');
    expect(suiteReportUrl('s1')).toBe('/api/suites/s1/report');
    expect(streamUrl('c1')).toBe('/api/campaigns/c1/stream');
    expect(auditExportUrl()).toBe('/api/audit/export');
  });
  it('append the encoded token when authenticated', () => {
    setToken('t k'); // a space exercises encodeURIComponent
    expect(reportUrl('r1')).toBe('/api/runs/r1/report?token=t%20k');
    expect(runsCsvUrl()).toBe('/api/runs.csv?token=t%20k');
    expect(runTimelineCsvUrl('r1')).toBe('/api/runs/r1/timeline.csv?token=t%20k');
    expect(complianceUrl()).toBe('/api/reports/compliance?token=t%20k');
    expect(suiteReportUrl('s1')).toBe('/api/suites/s1/report?token=t%20k');
    expect(streamUrl('c1')).toBe('/api/campaigns/c1/stream?token=t%20k');
    expect(auditExportUrl()).toBe('/api/audit/export?token=t%20k');
  });
});

describe('request helpers (auth headers)', () => {
  it('sends no authorization header without a token', async () => {
    const f = stubFetch([]);
    await api.listCampaigns();
    const [url, opts] = lastCall(f);
    expect(url).toBe('/api/campaigns');
    expect((opts?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });
  it('adds a bearer header and content-type on a JSON POST', async () => {
    setToken('tok');
    const f = stubFetch({});
    await api.createCampaign({ name: 'x' });
    const [url, opts] = lastCall(f);
    const headers = opts?.headers as Record<string, string>;
    expect(url).toBe('/api/campaigns');
    expect(opts?.method).toBe('POST');
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(opts?.body).toBe(JSON.stringify({ name: 'x' }));
  });
  it('omits content-type on a bodyless POST', async () => {
    const f = stubFetch({ status: 'ok' });
    await api.execute('c1');
    const [url, opts] = lastCall(f);
    const headers = opts?.headers as Record<string, string>;
    expect(url).toBe('/api/campaigns/c1/execute');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
  });
});

describe('json() error handling', () => {
  it('rejects with the server error message', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(api.listCampaigns()).rejects.toThrow('boom');
  });
  it('falls back to statusText when the body carries no error', async () => {
    stubFetch({}, { ok: false, status: 500 });
    await expect(api.listCampaigns()).rejects.toThrow('Status');
  });
  it('clears the token on a 401', async () => {
    setToken('tok');
    stubFetch({ error: 'nope' }, { ok: false, status: 401 });
    await expect(api.me()).rejects.toThrow('nope');
    expect(getToken()).toBeNull();
  });
  it('tolerates a non-JSON body', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Boom',
      json: () => Promise.reject(new Error('not json')),
    });
    global.fetch = fn as unknown as typeof fetch;
    await expect(api.listCampaigns()).rejects.toThrow('Boom');
  });
});

describe('api surface (every endpoint maps to a URL and verb)', () => {
  const check = async (
    call: () => Promise<unknown>,
    url: string,
    method: string,
    body?: unknown,
  ) => {
    const f = stubFetch({});
    await call();
    const [u, opts] = lastCall(f);
    expect(u).toBe(url);
    expect(opts?.method ?? 'GET').toBe(method);
    if (body !== undefined) expect(opts?.body).toBe(JSON.stringify(body));
  };

  it('covers reads and mutations', async () => {
    await check(() => api.health(), '/health', 'GET');
    await check(() => api.login('e', 'p'), '/api/auth/login', 'POST', {
      email: 'e',
      password: 'p',
    });
    await check(() => api.me(), '/api/auth/me', 'GET');
    await check(() => api.listCampaigns(), '/api/campaigns', 'GET');
    await check(() => api.createCampaign({ name: 'n' }), '/api/campaigns', 'POST', { name: 'n' });
    await check(
      () => api.approve('c1', { decision: 'APPROVED' }),
      '/api/campaigns/c1/approval',
      'POST',
      { decision: 'APPROVED' },
    );
    await check(() => api.kill('c1'), '/api/campaigns/c1/kill', 'POST');
    await check(() => api.getRun('r1'), '/api/runs/r1', 'GET');
    await check(() => api.audit(), '/api/audit?limit=100', 'GET');
    await check(() => api.audit(50), '/api/audit?limit=50', 'GET');
    await check(() => api.verifyAudit(), '/api/audit/verify', 'GET');
    await check(() => api.wrsHistory(), '/api/wrs/history', 'GET');
    await check(() => api.agents(), '/api/agents', 'GET');
    await check(() => api.notifyTest(), '/api/notify/test', 'POST');
    await check(() => api.listUsers(), '/api/users', 'GET');
    await check(
      () => api.createUser({ email: 'a@b', role: 'viewer', password: 'p' }),
      '/api/users',
      'POST',
      { email: 'a@b', role: 'viewer', password: 'p' },
    );
    await check(() => api.updateUserRole('a@b', 'officer'), '/api/users/a%40b', 'PATCH', {
      role: 'officer',
    });
    await check(() => api.deleteUser('a@b'), '/api/users/a%40b', 'DELETE');
    await check(() => api.playbooks(), '/api/playbooks', 'GET');
    await check(() => api.createPlaybook({ name: 'p' }), '/api/playbooks', 'POST', { name: 'p' });
    await check(() => api.deletePlaybook('p1'), '/api/playbooks/p1', 'DELETE');
    await check(
      () => api.instantiatePlaybook('p1', { target: 't' }),
      '/api/playbooks/p1/instantiate',
      'POST',
      { target: 't' },
    );
    await check(() => api.suites(), '/api/suites', 'GET');
  });
});
