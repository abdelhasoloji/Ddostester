import { initialClients } from '../modules/infrastructure/clients.js';
import { runAttachment, benchAttachment } from '../modules/drs/attachments.js';
import { DRS_EVIDENCE_LIMITS } from '../config/limits.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Permission } from '../auth/rbac.js';
import type { Store } from '../store/types.js';
import { randomUUID } from 'node:crypto';
import { mutationActor } from '../store/audited.js';
import { drsReference, digest } from '../modules/drs/reference.js';
import { DrsError, ensure } from '../modules/drs/model.js';
import type { DrsPlan, DrsEvidence } from '../modules/drs/model.js';
import {
  defaultPlan,
  createRevision,
  currentRevision,
  freeze,
  capacity,
  appendProof,
  simulate,
  finalize,
} from '../modules/drs/workflow.js';
import { drsReport, drsReportHtml } from '../modules/drs/report.js';
import type { Campaign } from '../modules/campaigns/model.js';
export function registerDrsRoutes(
  app: FastifyInstance,
  store: Store,
  guard: (permission: Permission) => preHandlerHookHandler,
) {
  app.post('/api/drs/validations', { preHandler: guard('campaign:create') }, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { maxLevel?: number; clientId?: unknown };
      const level = body.maxLevel ?? 1;
      const client = initialClients.find((c) => c.id === body.clientId);
      ensure(body.clientId === undefined || !!client, 'Unknown authorized client');
      ensure(Number.isInteger(level) && level >= 1 && level <= 7, 'Level must be 1–7');
      const actor = mutationActor.getStore() ?? req.authUser?.email ?? 'dev';
      const c: Campaign = {
        id: randomUUID(),
        name: 'DRS engine validation · virtual events',
        drsMode: 'engine-validation',
        createdBy: actor,
        createdAt: new Date().toISOString(),
        status: 'PENDING_APPROVAL',
        target: 'simulation://fixture',
        probeUrl: 'simulation://fixture',
        authorized: false,
        agent: 'simulation',
        vector: 'http-get',
        maxRps: 3,
        concurrency: 3,
        maxDurationSec: 20,
      };
      const plan = defaultPlan(c, 'engine-validation');
      plan.maxLevel = level;
      plan.services[0].protocol = 'SIMULATION';
      plan.services[0].journey = 'Virtual functional transaction';
      plan.services[0].functionalAssertion = 'Simulation fixture only';
      c.drsDocument = createRevision(undefined, plan, actor);
      await store.transaction(async (tx) => {
        if (client) {
          const saved = (await tx.listInfrastructure('client')).find((r) => r.id === client.id);
          c.clientWorkspace = {
            id: client.id,
            revision: saved?.revision ?? 0,
            hash: saved?.hash ?? null,
            profile: structuredClone((saved?.payload ?? client.profile) as typeof client.profile),
          };
          c.name = client.profile.name + ' · DRS prototype';
        }
        await tx.saveCampaign(c);
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'drs.verdict',
          campaignId: c.id,
          detail:
            'Created offline engine validation; no target authorization, generator or traffic ' +
            digest({ document: c.drsDocument, clientWorkspace: c.clientWorkspace ?? null }),
        });
      });
      return reply.code(201).send(c);
    } catch (e) {
      if (e instanceof DrsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
  app.get('/api/drs/reference', { preHandler: guard('campaign:read') }, async () => drsReference());
  app.get('/api/campaigns/:id/drs', { preHandler: guard('campaign:read') }, async (req, reply) => {
    const c = await store.getCampaign((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: 'Campaign not found' });
    return {
      clientWorkspace: c.clientWorkspace ?? null,
      archived: c.archived === true,
      document: c.drsDocument ?? null,
      defaultPlan: defaultPlan(c),
      execution: 'Evidence workflow; never dispatches traffic or bypasses campaign approval',
    };
  });
  for (const format of ['json', 'html'] as const)
    app.get(
      '/api/campaigns/:id/drs/report.' + format,
      { preHandler: guard('campaign:read') },
      async (req, reply) => {
        try {
          const c = await store.getCampaign((req.params as { id: string }).id);
          if (!c) return reply.code(404).send({ error: 'Campaign not found' });
          const rev = (req.query as { revision?: string }).revision;
          const r = rev
            ? c.drsDocument?.revisions.find((r) => String(r.number) === rev)
            : c.drsDocument?.revisions.find((r) => r.number === c.drsDocument?.currentRevision);
          ensure(r?.planHash, 'Frozen revision not found');
          return format === 'html'
            ? reply
                .type('text/html; charset=utf-8')
                .header(
                  'Content-Security-Policy',
                  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
                )
                .send(drsReportHtml(r, c.clientWorkspace))
            : drsReport(r, c.clientWorkspace);
        } catch (e) {
          if (e instanceof DrsError) return reply.code(400).send({ error: e.message });
          throw e;
        }
      },
    );
  const actions = {
    revisions: 'campaign:create',
    freeze: 'campaign:approve',
    capacity: 'campaign:create',
    simulate: 'campaign:execute',
    evidence: 'campaign:approve',
    finalize: 'campaign:approve',
    attachments: 'campaign:approve',
  } as const;
  for (const [action, permission] of Object.entries(actions))
    app.post(
      '/api/campaigns/:id/drs/' + action,
      { preHandler: guard(permission) },
      async (req, reply) => {
        try {
          const body = (req.body ?? {}) as {
            plan?: DrsPlan;
            runId?: string;
            benchRunId?: string;
            revisionId?: string;
            fixture?: string;
            confirmed?: boolean;
            evidence?: DrsEvidence;
          };
          return await store.transaction(async (tx) => {
            const stored = await tx.getCampaign((req.params as { id: string }).id);
            if (!stored) return reply.code(404).send({ error: 'Campaign not found' });
            const c: Campaign = structuredClone(stored);
            ensure(!c.archived, 'Archived campaign is read-only');
            ensure(
              c.status !== 'RUNNING',
              'Evidence mutations wait until physical campaign settles',
            );
            const actor = mutationActor.getStore() ?? req.authUser?.email ?? 'dev';
            let output: unknown;
            if (action === 'revisions') {
              ensure(body.plan, 'Plan required');
              c.drsDocument = createRevision(c.drsDocument, body.plan, actor);
              c.drsMode = body.plan.mode;
              output = c.drsDocument;
            } else {
              const r = currentRevision(c.drsDocument);
              ensure(body.revisionId === r.id, 'Revision changed; reload before mutating');
              if (action === 'freeze') freeze(r, c);
              if (action === 'capacity') output = capacity(r);
              if (action === 'simulate') {
                ensure(body.confirmed === true, 'Explicit simulation confirmation required');
                const fixture = body.fixture ?? 'healthy';
                ensure(
                  ['healthy', 'generator-saturation', 'service-outage', 'telemetry-gap'].includes(
                    fixture,
                  ),
                  'Unknown fixture',
                );
                output = simulate(r, actor, fixture as 'healthy');
              }
              if (action === 'evidence') {
                ensure(body.evidence, 'Evidence required');
                appendProof(r, body.evidence, actor, 'collector-import');
              }
              if (action === 'attachments') {
                ensure(
                  r.planHash && !r.finalizedAt && r.plan.mode !== 'engine-validation',
                  'Only a frozen active physical assessment can attach measured observations',
                );
                ensure(
                  Boolean(body.runId) !== Boolean(body.benchRunId),
                  'Select exactly one source observation',
                );
                let attachment;
                if (body.runId) {
                  const run = await tx.getRun(body.runId);
                  ensure(run, 'Source run not found');
                  const sourceCampaign = await tx.getCampaign(run.campaignId);
                  ensure(
                    sourceCampaign?.target === c.target,
                    'Run target is outside this campaign scope',
                  );
                  attachment = runAttachment(run);
                } else {
                  const run = await tx.getBenchRun(body.benchRunId!);
                  ensure(
                    run?.status === 'COMPLETED' && run.verdict,
                    'Completed lab verdict required',
                  );
                  ensure(
                    r.plan.mode === 'synthetic-lab',
                    'Isolated bench observations belong only to synthetic laboratory mode',
                  );
                  attachment = benchAttachment(run);
                }
                r.attachments ??= [];
                ensure(
                  r.attachments.length < DRS_EVIDENCE_LIMITS.maxAttempts,
                  'Attachment limit reached',
                );
                ensure(
                  !r.attachments.some(
                    (a) => a.kind === attachment.kind && a.sourceId === attachment.sourceId,
                  ),
                  'Observation already archived',
                );
                r.attachments.push(attachment);
              }
              if (action === 'finalize') {
                output = finalize(r);
                if (r.plan.mode === 'engine-validation') {
                  c.status = 'COMPLETED';
                  c.statusDetail =
                    'Software validation completed; no traffic emitted or resilience measured';
                }
              }
              output = { document: c.drsDocument, result: output ?? null };
            }
            ensure(
              Buffer.byteLength(JSON.stringify(c.drsDocument), 'utf8') <=
                DRS_EVIDENCE_LIMITS.maxArchiveBytes,
              'Evidence archive storage limit reached; retain history and create a separate assessment campaign',
            );
            await tx.saveCampaign(c);
            await tx.saveAudit({
              id: randomUUID(),
              at: new Date().toISOString(),
              actor,
              action: 'drs.verdict',
              campaignId: c.id,
              detail: 'DRS ' + action + ' sha256=' + digest(c.drsDocument),
            });
            return output;
          });
        } catch (e) {
          if (e instanceof DrsError) return reply.code(400).send({ error: e.message });
          throw e;
        }
      },
    );
}
