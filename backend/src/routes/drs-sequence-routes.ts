import { assessDrs } from '../modules/drs/scoring.js';
import { fleetDeviceView } from '../modules/fleet/devices.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Store } from '../store/index.js';
import type { Permission } from '../auth/rbac.js';
import type { HardCaps } from '../config/limits.js';
import { createCampaign, CampaignError } from '../modules/campaigns/service.js';
import type { AgentChoice } from '../modules/campaigns/service.js';
import type { CampaignInput } from '../modules/campaigns/model.js';
import { drsSequencePlan, savedDrsSequencePlan } from '../modules/drs/sequence.js';
import { DrsError, ensure } from '../modules/drs/model.js';
import { currentRevision, freeze } from '../modules/drs/workflow.js';
import { mutationActor } from '../store/audited.js';
export function registerDrsSequenceRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (p: Permission) => preHandlerHookHandler,
  allowed: () => Promise<string[]>,
  choices: () => AgentChoice[],
  caps: () => HardCaps,
) {
  app.get('/api/drs/sequences/plan', { preHandler: guard('campaign:read') }, async (req, reply) => {
    try {
      const q = req.query as { targetLevel?: string; intervalSec?: string };
      return drsSequencePlan(Number(q.targetLevel ?? 5), Number(q.intervalSec ?? 30));
    } catch (e) {
      if (e instanceof DrsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  app.post('/api/drs/sequences', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const b = req.body as CampaignInput & { targetLevel: number; intervalSec: number };
      ensure(!!b && typeof b === 'object', 'Campaign configuration required');
      ensure(
        typeof b.name === 'string' && b.name.trim().length > 0 && b.name.length <= 160,
        'Campaign name required (maximum 160 characters)',
      );
      const plan = drsSequencePlan(b.targetLevel, b.intervalSec);
      const actor = req.authUser?.email ?? b.createdBy ?? mutationActor.getStore() ?? 'dev';
      const suiteId = randomUUID();
      const hosts = await allowed();
      const members = plan.rows
        .filter((r) => r.supported)
        .map((row, index) => {
          const c = createCampaign(
            {
              name: `DRS ${row.level} · ${row.name}`,
              createdBy: actor,
              authorized: b.authorized,
              target: b.target,
              probeUrl: b.probeUrl,
              referenceUrl: b.referenceUrl,
              probeVantage: b.probeVantage,
              agent: 'fleet',
              fleetDeviceIds: b.fleetDeviceIds,
              drsMode: 'synthetic-lab',
              drsProfileId: row.id,
              vector: 'http-get',
              maxRps: b.maxRps,
              concurrency: b.concurrency,
              maxDurationSec: b.maxDurationSec,
              suiteId,
              suiteName: b.name.trim(),
              suiteOrder: index,
            },
            hosts,
            choices(),
            caps(),
          );
          c.drsSequence = {
            referenceRows: plan.rows,
            schema: plan.schema,
            targetLevel: plan.targetLevel,
            intervalSec: plan.intervalSec,
            catalogueHash: plan.catalogueHash,
            planHash: plan.planHash,
          };
          savedDrsSequencePlan(c.drsSequence!);
          const revision = currentRevision(c.drsDocument);
          revision.plan.maxLevel = row.level;
          return c;
        });
      ensure(members.length > 0, 'No executable scenario available');
      for (const id of members[0].fleetDeviceIds ?? []) {
        const d = await store.getFleetDevice(id);
        ensure(
          !!d &&
            fleetDeviceView(d).connection === 'online' &&
            d.heartbeat?.version === 'fleet-mission-agent/v1',
          'Selected Fleet agent is unavailable',
        );
      }
      await store.transaction(async (tx) => {
        for (const c of members) await tx.saveCampaign(c);
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'campaign.create',
          detail: `DRS sequence ${suiteId}; target level ${plan.targetLevel}; ${members.length} executable; ${plan.blocked} unavailable; interval ${plan.intervalSec}s; plan ${plan.planHash}`,
        });
      });
      return reply.code(201).send({ suiteId, campaigns: members, plan });
    } catch (e) {
      if (e instanceof DrsError || e instanceof CampaignError)
        return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  app.get<{ Params: { id: string } }>(
    '/api/suites/:id/drs/plan',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const first = (await store.listCampaigns()).find(
        (c) => c.suiteId === req.params.id && c.drsSequence,
      );
      if (!first?.drsSequence) return reply.code(404).send({ error: 'Campaign not found' });
      try {
        return savedDrsSequencePlan(first.drsSequence);
      } catch (e) {
        if (e instanceof DrsError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/suites/:id/drs/report',
    { preHandler: guard('campaign:read') },
    async (req, reply) => {
      const members = (await store.listCampaigns())
        .filter((c) => c.suiteId === req.params.id)
        .sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
      const binding = members[0]?.drsSequence;
      if (!binding) return reply.code(404).send({ error: 'DRS campaign not found' });
      const plan = savedDrsSequencePlan(binding);
      if (plan.planHash !== binding.planHash)
        return reply.code(409).send({ error: 'Reference plan mismatch' });
      const rows = plan.rows.map((row) => {
        const c = members.find((c) => c.drsProfileId === row.id);
        const revision = c?.drsDocument?.revisions.find(
          (r) => r.number === c.drsDocument?.currentRevision,
        );
        let assessment: ReturnType<typeof assessDrs> | null = null;
        try {
          if (revision?.planHash) assessment = assessDrs(revision);
        } catch {
          /* Integrity failures remain unknown. */
        }
        return {
          id: row.id,
          name: `DRS ${row.level} · ${row.name}`,
          level: row.level,
          supported: row.supported,
          campaignId: c?.id ?? null,
          state: c?.status ?? 'NOT_EVALUATED',
          assessment,
        };
      });
      const report = {
        suiteId: req.params.id,
        name: members[0].suiteName,
        target: members[0].target,
        targetLevel: plan.targetLevel,
        intervalSec: plan.intervalSec,
        catalogueHash: plan.catalogueHash,
        planHash: plan.planHash,
        mode: 'synthetic-lab',
        status: 'PARTIAL',
        score: null,
        executable: plan.executable,
        missing: plan.blocked,
        rows,
        reservations: [
          'Laboratory scenario chain; no full-standard measured score',
          'Missing vectors remain unevaluated',
          'Scenario scores are never averaged into a DRS score',
        ],
      };
      if (req.query.format !== 'html') return report;
      const esc = (v: unknown) =>
        String(v ?? '—').replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
        );
      return reply
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><meta charset="utf-8"><title>DRS campaign report</title><style>body{font:15px system-ui;margin:40px auto;max-width:1100px;padding:20px;color:#15213a}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}code{overflow-wrap:anywhere}</style><h1>' +
            esc(report.name) +
            '</h1><p>' +
            esc(report.target) +
            ' · DRS ' +
            report.targetLevel +
            ' objective · ' +
            report.intervalSec +
            's minimum interval</p><p>Laboratory campaign · PARTIAL · no measured DRS score</p><p>' +
            report.executable +
            ' executable / ' +
            report.missing +
            ' awaiting generator</p><table><tr><th>Level</th><th>Scenario</th><th>Execution</th><th>Evidence</th></tr>' +
            rows
              .map(
                (r) =>
                  '<tr><td>' +
                  r.level +
                  '</td><td>' +
                  esc(r.name) +
                  '</td><td>' +
                  esc(r.state) +
                  '</td><td>' +
                  esc(r.assessment?.status ?? 'Not evaluated') +
                  '</td></tr>',
              )
              .join('') +
            '</table><p>Reference <code>' +
            esc(report.catalogueHash) +
            '</code></p><p>Plan <code>' +
            esc(report.planHash) +
            '</code></p><ul>' +
            report.reservations.map((r) => '<li>' + esc(r) + '</li>').join('') +
            '</ul></html>',
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/suites/:id/drs/freeze',
    { preHandler: guard('campaign:approve') },
    async (req, reply) => {
      try {
        const body = req.body as { planHash?: string };
        const members = await store.transaction(async (tx) => {
          const rows = (await tx.listCampaigns()).filter((c) => c.suiteId === req.params.id);
          ensure(rows.length > 0, 'Campaign sequence not found');
          for (const c of rows) {
            ensure(
              !c.archived && ['PENDING_APPROVAL', 'APPROVED'].includes(c.status),
              'Only an inactive campaign can be frozen',
            );
            ensure(
              !!c.drsSequence &&
                typeof body?.planHash === 'string' &&
                c.drsSequence.planHash === body.planHash,
              'Sequence changed; reload before freezing',
            );
            savedDrsSequencePlan(c.drsSequence!);
            const revision = currentRevision(c.drsDocument);
            if (!revision.planHash) freeze(revision, c);
            ensure(!revision.finalizedAt, 'A finalized scenario requires a new campaign');
          }
          for (const c of rows) await tx.saveCampaign(c);
          await tx.saveAudit({
            id: randomUUID(),
            at: new Date().toISOString(),
            actor: mutationActor.getStore() ?? req.authUser?.email ?? 'dev',
            action: 'campaign.approve',
            detail: `DRS sequence ${req.params.id} plans frozen; no traffic dispatched`,
          });
          return rows;
        });
        return { campaigns: members };
      } catch (e) {
        if (e instanceof DrsError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
}
