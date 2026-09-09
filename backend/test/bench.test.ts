import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { hashPassword } from '../src/auth/passwords.js';

const ALLOWED = ['127.0.0.1', 'localhost'];
const LAB = ['lab-target.internal'];
const RUNNER_TOKEN = 'runner-secret-token';

async function login(app: FastifyInstance, email: string, pw: string): Promise<string> {
  return (
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: pw } })
  ).json().token;
}

function buildAuth() {
  const AUTH_USERS = JSON.stringify([
    { email: 'ciso@wedos', role: 'ciso', passwordHash: hashPassword('pw-ciso-1234') },
    { email: 'off@wedos', role: 'officer', passwordHash: hashPassword('pw-officer-123') },
  ]);
  return initAuth({ AUTH_JWT_SECRET: 's', AUTH_USERS } as NodeJS.ProcessEnv);
}

const validVerdict = {
  schema: 'shieldtest.lab.verdict/v1',
  class: 'C',
  kind: 'udp-amplification',
  scenario: 'udp_dns_reflection',
  labTarget: 'lab-target.internal',
  amplificationFactor: 40,
  packetAmplification: 1,
  requests: 200,
  target: { packets: 400, avgPps: 50, avgBps: 8000 },
  mitigation: null,
  outcome: 'UNMITIGATED_BASELINE',
  source: 'shieldtest-lab',
  generatedAt: new Date().toISOString(),
};

describe('Network bench — governed record-and-dispatch (zeroBS Volumetric)', () => {
  let app: FastifyInstance;
  let ciso = '';
  let officer = '';

  beforeAll(async () => {
    app = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        labTargets: LAB,
        benchRunnerToken: RUNNER_TOKEN,
        logger: false,
        serveStatic: false,
      })
    ).app;
    ciso = await login(app, 'ciso@wedos', 'pw-ciso-1234');
    officer = await login(app, 'off@wedos', 'pw-officer-123');
  });

  const asCiso = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${ciso}` }, payload });
  const asRunner = (url: string, payload: object, token = RUNNER_TOKEN) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });

  it('exposes the full zeroBS Volumetric matrix to the CISO, not the officer', async () => {
    const ok = await asCiso('GET', '/api/bench/scenarios');
    expect(ok.statusCode).toBe(200);
    const scenarios = ok.json().scenarios;
    expect(scenarios.length).toBe(11); // the report's 11 volumetric vectors
    // Reproducible vectors (UDP amplification + no-spoof TCP pressure) and
    // out-of-model vectors (spoofing / GRE / fragmentation) both present.
    const dns = scenarios.find((s: { id: string }) => s.id === 'udp_dns_reflection');
    const syn = scenarios.find((s: { id: string }) => s.id === 'tcp_synflood');
    const spoof = scenarios.find((s: { id: string }) => s.id === 'ip_spoofing');
    const gre = scenarios.find((s: { id: string }) => s.id === 'gre_packets');
    expect(dns.reproducible).toBe(true);
    expect(dns.drs).toBe(3);
    expect(syn.reproducible).toBe(true); // no-spoof TCP state-table pressure
    expect(spoof.reproducible).toBe(false); // spoofing never reproduced
    expect(gre.reproducible).toBe(false);
    expect(ok.json().dispatchEnabled).toBe(true);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/bench/scenarios',
      headers: { authorization: `Bearer ${officer}` },
    });
    expect(denied.statusCode).toBe(403); // officer has no bench:read
  });

  it('runs the full governed loop: request → claim → verdict → recorded', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'udp_dns_reflection' });
    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run).toMatchObject({
      status: 'REQUESTED',
      scenario: 'udp_dns_reflection',
      labTarget: 'lab-target.internal',
    });

    const claimed = await asRunner('/api/bench/runs/next/claim', { runner: 'lab-runner-1' });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      id: run.id,
      status: 'CLAIMED',
      claimedBy: 'lab-runner-1',
    });

    const done = await asRunner(`/api/bench/runs/${run.id}/result`, { verdict: validVerdict });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'COMPLETED' });
    expect(done.json().verdict.amplificationFactor).toBe(40);

    const listed = await asCiso('GET', '/api/bench/runs');
    const found = listed.json().runs.find((r: { id: string }) => r.id === run.id);
    expect(found.status).toBe('COMPLETED');
    expect(found.verdict.outcome).toBe('UNMITIGATED_BASELINE');

    const audit = await asCiso('GET', '/api/audit');
    const dump = JSON.stringify(audit.json());
    expect(dump).toContain('bench.request');
    expect(dump).toContain('bench.verdict');

    // A real run also records MEASURED_LAB coverage for its vector.
    const cov = (await asCiso('GET', '/api/bench/coverage')).json().coverage;
    const measured = cov.find(
      (c: { vector: string; method: string }) =>
        c.vector === 'udp_dns_reflection' && c.method === 'MEASURED_LAB',
    );
    expect(measured).toBeTruthy();
  });

  it('serves the latest lab-scrubber mitigation timing to the protection connector', async () => {
    // Dispatch, claim and post a verdict where the scrubber DID engage.
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'udp_dns_reflection' });
    const run = created.json();
    const claimed = await asRunner('/api/bench/runs/next/claim', { runner: 'lab-runner-1' });
    const claimedId = claimed.json().id ?? run.id;
    const mitigated = {
      ...validVerdict,
      outcome: 'MITIGATED',
      mitigation: {
        strategy: 'adaptive',
        engaged: true,
        detectionSec: 12,
        dropped: 300,
        collateralPct: 2,
      },
    };
    const done = await asRunner(`/api/bench/runs/${claimedId}/result`, { verdict: mitigated });
    expect(done.statusCode).toBe(200);

    // The pull connector GETs with the marker header; the adapter maps the
    // verdict's mitigation timing into the protection-measurement shape.
    const res = await app.inject({
      method: 'GET',
      url: '/api/protection/lab-metrics?campaignId=c1&target=bank.cz&from=a&to=b',
      headers: { 'x-wedos-shieldtest': 'protection-query' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      detectionTimeSec: 12,
      mitigationTimeSec: 12, // mitigation starts at detection when engaged
      source: 'wedos-lab-scrubber',
      strategy: 'adaptive',
    });

    // Not exposed without the connector's marker header.
    const noHeader = await app.inject({ method: 'GET', url: '/api/protection/lab-metrics' });
    expect(noHeader.statusCode).toBe(404);
  });

  it('lets the CISO record coverage for an out-of-model vector (attestation)', async () => {
    const r = await asCiso('POST', '/api/bench/coverage', {
      vector: 'ip_spoofing',
      method: 'ATTESTED',
      outcome: 'PASS',
      summary: 'Edge enforces BCP38/uRPF ingress filtering; spoofed sources dropped.',
      source: 'edge-config',
    });
    expect(r.statusCode).toBe(201);
    const cov = (await asCiso('GET', '/api/bench/coverage')).json().coverage;
    const att = cov.find((c: { vector: string; method: string }) => c.vector === 'ip_spoofing');
    expect(att.method).toBe('ATTESTED');
    expect(att.outcome).toBe('PASS');
    const audit = await asCiso('GET', '/api/audit');
    expect(JSON.stringify(audit.json())).toContain('bench.coverage');
  });

  it('rejects a hand-recorded MEASURED_LAB, an unknown vector, and a missing summary', async () => {
    // MEASURED_LAB can only come from an actual run, never hand-recorded.
    expect(
      (
        await asCiso('POST', '/api/bench/coverage', {
          vector: 'ip_spoofing',
          method: 'MEASURED_LAB',
          summary: 'nope',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await asCiso('POST', '/api/bench/coverage', {
          vector: 'not-a-vector',
          method: 'ATTESTED',
          summary: 'x',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await asCiso('POST', '/api/bench/coverage', { vector: 'gre_packets', method: 'ATTESTED' }))
        .statusCode,
    ).toBe(400); // missing summary
  });

  it('coverage recording is CISO-only (officer 403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bench/coverage',
      headers: { authorization: `Bearer ${officer}` },
      payload: { vector: 'gre_packets', method: 'ATTESTED', summary: 'GRE dropped at edge.' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('refuses out-of-model vectors (spoofing/GRE/fragmentation) and unknown ids', async () => {
    expect((await asCiso('POST', '/api/bench/runs', { scenario: 'ip_spoofing' })).statusCode).toBe(
      400,
    );
    expect((await asCiso('POST', '/api/bench/runs', { scenario: 'gre_packets' })).statusCode).toBe(
      400,
    );
    expect(
      (await asCiso('POST', '/api/bench/runs', { scenario: 'udp_fragmentation' })).statusCode,
    ).toBe(400);
    expect((await asCiso('POST', '/api/bench/runs', { scenario: 'nope' })).statusCode).toBe(400);
  });

  it('accepts the no-spoof TCP vectors and records a TCP verdict with connections', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'tcp_synflood' });
    expect(created.statusCode).toBe(201);
    const run = created.json();
    await asRunner('/api/bench/runs/next/claim', { runner: 'lab-runner-1' });
    const tcpVerdict = {
      schema: 'shieldtest.lab.verdict/v1',
      class: 'C',
      kind: 'tcp-connection-pressure',
      scenario: 'tcp_synflood',
      connections: {
        opened: 500,
        accepted: 200,
        refused: 300,
        concurrentPeak: 200,
        capacity: 200,
        saturationPct: 60,
      },
      outcome: 'STATE_TABLE_SATURATED',
      generatedAt: new Date().toISOString(),
    };
    const done = await asRunner(`/api/bench/runs/${run.id}/result`, { verdict: tcpVerdict });
    expect(done.statusCode).toBe(200);
    expect(done.json().verdict.connections.saturationPct).toBe(60);
    expect(done.json().verdict.outcome).toBe('STATE_TABLE_SATURATED');
    const cov = (await asCiso('GET', '/api/bench/coverage')).json().coverage;
    expect(
      cov.some(
        (c: { vector: string; method: string }) =>
          c.vector === 'tcp_synflood' && c.method === 'MEASURED_LAB',
      ),
    ).toBe(true);
  });

  it('rejects a non-lab target on a reproducible vector', async () => {
    const r = await asCiso('POST', '/api/bench/runs', {
      scenario: 'udp_maxpackets',
      labTarget: '127.0.0.1',
    });
    expect(r.statusCode).toBe(400);
  });

  it('dispatch is CISO-only (officer 403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bench/runs',
      headers: { authorization: `Bearer ${officer}` },
      payload: { scenario: 'udp_dns_reflection' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('the runner API requires the runner token', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/bench/runs/next/claim', payload: {} }))
        .statusCode,
    ).toBe(401);
    expect((await asRunner('/api/bench/runs/next/claim', {}, 'wrong-token')).statusCode).toBe(401);
  });

  it('rejects a verdict that is not class C', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'udp_maxpackets' });
    const run = created.json();
    await asRunner('/api/bench/runs/next/claim', { runner: 'r' });
    const bad = await asRunner(`/api/bench/runs/${run.id}/result`, {
      verdict: { ...validVerdict, class: 'B', scenario: 'udp_maxpackets' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/class/i);
  });

  it('exposes attestation checklists for the out-of-model vectors', async () => {
    const r = await asCiso('GET', '/api/bench/attestations');
    expect(r.statusCode).toBe(200);
    const checklists = r.json().checklists;
    const spoof = checklists.find((c: { id: string }) => c.id === 'bcp38-urpf');
    expect(spoof).toBeTruthy();
    expect(spoof.vector).toBe('ip_spoofing');
    expect(spoof.items.some((i: { required: boolean }) => i.required)).toBe(true);
  });

  it('records a PASS attestation when all required controls are ticked', async () => {
    const r = await asCiso('POST', '/api/bench/attestations', {
      checklistId: 'bcp38-urpf',
      checkedItems: ['ingress_acl', 'urpf', 'bogon'],
      note: 'verified against edge running-config',
    });
    expect(r.statusCode).toBe(201);
    const rec = r.json();
    expect(rec.vector).toBe('ip_spoofing');
    expect(rec.method).toBe('ATTESTED');
    expect(rec.outcome).toBe('PASS');
    expect(rec.summary).toContain('[x]');
    expect(rec.summary).toContain('verified against edge running-config');
    // It surfaces as coverage for the ip_spoofing vector.
    const cov = (await asCiso('GET', '/api/bench/coverage')).json().coverage;
    expect(
      cov.some(
        (c: { vector: string; method: string }) =>
          c.vector === 'ip_spoofing' && c.method === 'ATTESTED',
      ),
    ).toBe(true);
  });

  it('derives PARTIAL when a required control is missing', async () => {
    const r = await asCiso('POST', '/api/bench/attestations', {
      checklistId: 'gre-drop',
      checkedItems: ['default_drop'], // missing required 'allowlist'
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().outcome).toBe('PARTIAL');
  });

  it('rejects an unknown checklist id', async () => {
    const r = await asCiso('POST', '/api/bench/attestations', {
      checklistId: 'no-such-checklist',
      checkedItems: [],
    });
    expect(r.statusCode).toBe(400);
  });

  it('attestation is CISO-only (officer 403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bench/attestations',
      headers: { authorization: `Bearer ${officer}` },
      payload: { checklistId: 'bcp38-urpf', checkedItems: ['ingress_acl'] },
    });
    expect(r.statusCode).toBe(403);
  });

  it('refuses a duplicate result post (run no longer CLAIMED) — no double coverage', async () => {
    const created = await asCiso('POST', '/api/bench/runs', { scenario: 'udp_maxpackets' });
    const run = created.json();
    await asRunner('/api/bench/runs/next/claim', { runner: 'r-dup' });
    const v = { ...validVerdict, scenario: 'udp_maxpackets' };
    const first = await asRunner(`/api/bench/runs/${run.id}/result`, { verdict: v });
    expect(first.statusCode).toBe(200);
    const before = (await asCiso('GET', '/api/bench/coverage')).json().coverage.length;
    const second = await asRunner(`/api/bench/runs/${run.id}/result`, { verdict: v });
    expect(second.statusCode).toBe(409); // already COMPLETED, not CLAIMED
    const after = (await asCiso('GET', '/api/bench/coverage')).json().coverage.length;
    expect(after).toBe(before); // no duplicate MEASURED_LAB row
  });

  it('imports external verdicts (CSV) as INGESTED_EXTERNAL coverage', async () => {
    const csv = [
      'vector,outcome,drs,summary,source',
      'ip_spoofing,MITIGATED,4,"BCP38 upstream, spoofed dropped",acme-scrubbing',
      'gre_packets,MITIGATED,5,GRE dropped at edge,acme-scrubbing',
    ].join('\n');
    const r = await asCiso('POST', '/api/bench/coverage/import', { format: 'csv', data: csv });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.imported).toBe(2);
    expect(body.errors).toHaveLength(0);
    const cov = (await asCiso('GET', '/api/bench/coverage')).json().coverage;
    expect(
      cov.some(
        (c: { vector: string; method: string; summary: string }) =>
          c.vector === 'ip_spoofing' &&
          c.method === 'INGESTED_EXTERNAL' &&
          c.summary.includes('BCP38'),
      ),
    ).toBe(true);
  });

  it('imports external verdicts (JSON) and reports invalid rows without dropping the rest', async () => {
    const rows = [
      {
        vector: 'udp_fragmentation',
        outcome: 'MITIGATED',
        drs: 4,
        summary: 'frag limits enforced',
      },
      { vector: 'not_a_vector', summary: 'bogus' },
      { vector: 'tcp_fragmentation', summary: '' }, // missing summary
    ];
    const r = await asCiso('POST', '/api/bench/coverage/import', {
      format: 'json',
      data: JSON.stringify(rows),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.imported).toBe(1);
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0].row).toBe(2);
  });

  it('rejects an unparseable import body', async () => {
    const r = await asCiso('POST', '/api/bench/coverage/import', {
      format: 'json',
      data: '{ not json',
    });
    expect(r.statusCode).toBe(400);
  });

  it('coverage import is CISO-only (officer 403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/bench/coverage/import',
      headers: { authorization: `Bearer ${officer}` },
      payload: { format: 'json', data: '[]' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('dispatch fails closed without a runner token', async () => {
    const app2 = (
      await buildApp({
        store: new MemoryStore(),
        auth: buildAuth(),
        allowedTargets: ALLOWED,
        labTargets: LAB,
        logger: false,
        serveStatic: false,
      })
    ).app;
    const token = await login(app2, 'ciso@wedos', 'pw-ciso-1234');
    const r = await app2.inject({
      method: 'POST',
      url: '/api/bench/runs',
      headers: { authorization: `Bearer ${token}` },
      payload: { scenario: 'udp_dns_reflection' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/disabled/i);
  });
});
