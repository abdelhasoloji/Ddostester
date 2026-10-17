import { randomUUID } from 'node:crypto';
import type { Store } from '../../store/types.js';
import type { Campaign } from '../campaigns/model.js';
import type { BenchRun } from './model.js';
import {
  syntheticDefinition,
  legacySyntheticDefinition,
  simulateReference,
  type SyntheticDefinition,
  type SyntheticStep,
} from './scenario-plan.js';
export { syntheticDefinition } from './scenario-plan.js';
import { SYNTHETIC_JOURNEY_LIMITS as LIMITS } from '../../config/limits.js';
import { digest } from '../drs/reference.js';
import { ensure, planDigest } from '../drs/model.js';
import { defaultPlan, createRevision, currentRevision, freeze, finalize } from '../drs/workflow.js';
import { benchAttachment } from '../drs/attachments.js';

export type SyntheticState =
  'DRAFT' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface SyntheticJourney {
  schema: 'shieldtester.synthetic-journey/v1' | 'shieldtester.synthetic-journey/v2';
  state: SyntheticState;
  definition: SyntheticDefinition;
  planHash: string;
  steps: SyntheticStep[];
  nextAt?: number;
  startedAt?: string;
  finishedAt?: string;
  reason?: string;
}
export const syntheticActive = (state: SyntheticState) =>
  ['RUNNING', 'PAUSED', 'STOPPING'].includes(state);
function validBindings(j: SyntheticJourney) {
  const entries = j.definition.entries;
  return (
    !entries ||
    (entries.length === j.steps.length &&
      entries.every((e, i) => {
        const s = j.steps[i];
        return (
          e.vectorId === s.vectorId &&
          e.scenarioId === s.scenarioId &&
          e.execution === s.execution &&
          e.referenceHash === digest(e.referenceVector)
        );
      }))
  );
}
async function record(tx: Store, c: Campaign, actor: string, detail: string) {
  await tx.saveAudit({
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    action: 'drs.verdict',
    campaignId: c.id,
    detail,
  });
}
export class SyntheticCoordinator {
  private active = new Set<string>();
  private pending?: Promise<void>;
  private closing = false;
  constructor(
    private store: Store,
    private enabled: () => boolean,
    private targets: readonly string[],
    private now = Date.now,
  ) {}
  async create(
    input: {
      name: string;
      targetLevel: number;
      intervalSec: number;
      labTarget: string;
      authorized: boolean;
    },
    actor: string,
  ) {
    ensure(
      this.enabled() && this.targets.includes(input.labTarget),
      'An isolated configured bench target and runner are required',
    );
    ensure(input.authorized === true, 'Explicit laboratory authorization required');
    ensure(
      typeof input.name === 'string' &&
        input.name.trim().length > 0 &&
        input.name.trim().length <= 160,
      'Campaign name must be 1–160 characters',
    );
    const definition = syntheticDefinition(input.targetLevel, input.intervalSec, input.labTarget);
    const c: Campaign = {
      id: randomUUID(),
      name: input.name.trim(),
      createdBy: actor,
      createdAt: new Date(this.now()).toISOString(),
      status: 'PENDING_APPROVAL',
      authorized: true,
      target: `http://${input.labTarget}/`,
      probeUrl: `http://${input.labTarget}/`,
      agent: 'synthetic-bench',
      vector: 'http-get',
      ...LIMITS.assessmentBudget,
      drsMode: 'synthetic-lab',
      syntheticJourney: {
        schema: 'shieldtester.synthetic-journey/v2',
        state: 'DRAFT',
        definition,
        planHash: digest(definition),
        steps: definition.entries!.map(({ vectorId, name, level, execution, scenarioId }) => ({
          vectorId,
          name,
          level,
          execution,
          scenarioId,
        })),
      },
    };
    const plan = defaultPlan(c, 'synthetic-lab');
    plan.maxLevel = input.targetLevel;
    plan.services[0].protocol = 'SYNTHETIC';
    plan.services[0].journey = 'Isolated named traffic-shape diagnostics';
    plan.sources[0].resourceId = 'isolated-bench-runner';
    plan.sources[0].position = 'Isolated synthetic bench';
    plan.componentVersions.syntheticContract = 'reference-steps/v2';
    c.drsDocument = createRevision(undefined, plan, actor);
    await this.store.transaction(async (tx) => {
      await tx.saveCampaign(c);
      await record(
        tx,
        c,
        actor,
        'Synthetic draft created; no traffic requested; plan ' + c.syntheticJourney!.planHash,
      );
    });
    return c;
  }
  async control(
    id: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    actor: string,
    options: {
      confirmed?: boolean;
      planHash?: string;
      requireApproval?: boolean;
      requireCiso?: boolean;
    } = {},
  ) {
    const result = await this.store.transaction(async (tx) => {
      const c = await tx.getCampaign(id);
      ensure(c?.syntheticJourney, 'Synthetic campaign not found');
      const j = c.syntheticJourney;
      if (action === 'start') {
        ensure(
          j.state === 'DRAFT' && ['PENDING_APPROVAL', 'APPROVED'].includes(c.status) && !c.archived,
          'Only an unarchived draft may launch',
        );
        ensure(
          this.enabled() && this.targets.includes(j.definition.labTarget),
          'Isolated bench is unavailable',
        );
        ensure(
          options.confirmed === true &&
            options.planHash === j.planHash &&
            digest(j.definition) === j.planHash,
          'Review the exact plan and explicitly confirm launch',
        );
        ensure(
          digest(
            (j.definition.entries ? syntheticDefinition : legacySyntheticDefinition)(
              j.definition.reference.targetLevel,
              j.definition.reference.intervalSec,
              j.definition.labTarget,
            ),
          ) === j.planHash,
          'Reference/capability changed; create a new campaign',
        );
        ensure(validBindings(j), 'Synthetic reference step binding changed');
        ensure(c.authorized === true, 'Laboratory authorization missing');
        if (options.requireApproval)
          ensure(
            c.status === 'APPROVED' && !!c.approvedBy && c.approvedBy !== actor,
            'Separate campaign approval required',
          );
        ensure(
          !c.approvalExpiresAt || Date.parse(c.approvalExpiresAt) > this.now(),
          'Campaign approval expired',
        );
        if (options.requireCiso) ensure(!!c.cisoApprovedBy, 'CISO sign-off required');
        const others = (await tx.listCampaigns()).filter(
          (x) => x.id !== id && x.syntheticJourney && syntheticActive(x.syntheticJourney.state),
        );
        ensure(others.length < LIMITS.maxActive, 'Another synthetic campaign is active');
        ensure(
          (await tx.listBenchRuns(1, true)).length === 0,
          'The bench is busy; wait for its current observation',
        );
        const r = currentRevision(c.drsDocument);
        if (!r.planHash) freeze(r, c);
        ensure(
          r.planHash === planDigest(r) && !r.finalizedAt && r.plan.mode === 'synthetic-lab',
          'Frozen synthetic plan required',
        );
        j.state = 'RUNNING';
        j.startedAt = new Date(this.now()).toISOString();
        c.status = 'RUNNING';
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date(this.now()).toISOString(),
          actor,
          action: 'campaign.confirm',
          campaignId: c.id,
          detail: 'Explicit synthetic laboratory plan confirmation ' + j.planHash,
        });
      } else if (action === 'pause') {
        ensure(j.state === 'RUNNING', 'Campaign is not running');
        j.state = 'PAUSED';
      } else if (action === 'resume') {
        ensure(j.state === 'PAUSED', 'Campaign is not paused');
        j.state = 'RUNNING';
      } else {
        ensure(syntheticActive(j.state) || j.state === 'DRAFT', 'Campaign has already settled');
        j.state = 'STOPPING';
        j.reason = 'Stopped by operator; no following scenario will be queued';
        c.status = 'RUNNING';
      }
      await tx.saveCampaign(c);
      await record(tx, c, actor, 'Synthetic ' + action);
      return c;
    });
    this.active.add(id);
    await this.tick();
    return (await this.store.getCampaign(result.id))!;
  }
  async claim(runnerId: string) {
    await this.tick();
    return this.store.transaction(async (tx) => {
      for (const id of this.active) {
        const c = await tx.getCampaign(id);
        if (c?.syntheticJourney?.state === 'PAUSED') return undefined;
      }
      const run = await tx.claimNextBenchRun(runnerId);
      if (run)
        await tx.saveAudit({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor: runnerId,
          action: 'store.mutate',
          detail: 'claimNextBenchRun ' + run.id,
        });
      return run;
    });
  }
  /** Restart never resumes admission; a claimed bounded step may still settle. */
  async reconcile() {
    for (const c of await this.store.listCampaigns())
      if (c.syntheticJourney && syntheticActive(c.syntheticJourney.state)) {
        await this.store.transaction(async (tx) => {
          const fresh = (await tx.getCampaign(c.id))!;
          fresh.syntheticJourney!.state = 'STOPPING';
          fresh.syntheticJourney!.reason = 'Interrupted by restart; no automatic replay';
          await tx.saveCampaign(fresh);
          await record(tx, fresh, 'system', 'Synthetic restart admission stopped');
        });
        this.active.add(c.id);
      }
  }
  async tick() {
    if (this.pending) return this.pending;
    if (this.closing) return;
    this.pending = (async () => {
      for (const id of this.active) {
        if (this.closing) break;
        await this.store.transaction(async (tx) => {
          const c = await tx.getCampaign(id);
          if (!c?.syntheticJourney || !syntheticActive(c.syntheticJourney.state)) {
            return;
          }
          const j = c.syntheticJourney,
            r = currentRevision(c.drsDocument),
            now = this.now();
          if (
            !validBindings(j) ||
            c.archived ||
            !this.enabled() ||
            !this.targets.includes(j.definition.labTarget) ||
            digest(j.definition) !== j.planHash ||
            (!!r.planHash && r.planHash !== planDigest(r))
          ) {
            j.state = 'STOPPING';
            j.reason = 'Admission configuration or plan integrity changed';
          }
          let waiting = false,
            failed = false;
          for (const step of j.steps)
            if (step.runId) {
              let run = await tx.getBenchRun(step.runId);
              ensure(
                run && run.scenario === step.scenarioId && run.labTarget === j.definition.labTarget,
                'Synthetic run binding mismatch',
              );
              if (run.status === 'REQUESTED' && j.state === 'STOPPING')
                run = (await tx.setBenchRunResult(run.id, {
                  error: 'Cancelled before runner claim',
                }))!;
              if (['REQUESTED', 'CLAIMED'].includes(run.status)) {
                const age = now - Date.parse(run.claimedAt ?? run.requestedAt),
                  timeout =
                    run.status === 'CLAIMED' ? LIMITS.resultTimeoutSec : LIMITS.queueTimeoutSec;
                if (age > timeout * 1000) {
                  run = (await tx.setBenchRunResult(run.id, {
                    error: 'Runner observation timed out; no subsequent scenario admitted',
                  }))!;
                  j.reason = run.error;
                } else {
                  waiting = true;
                  continue;
                }
              }
              if (
                run.status === 'COMPLETED' &&
                !r.attachments?.some((a) => a.kind === 'network-bench' && a.sourceId === run!.id)
              ) {
                r.attachments ??= [];
                r.attachments.push(benchAttachment(run));
                j.nextAt = now + j.definition.reference.intervalSec * 1000;
                await record(tx, c, 'system', 'Synthetic observation archived ' + run.id);
              }
              if (run.status === 'COMPLETED')
                step.result ??= {
                  kind: 'LAB_MEASUREMENT',
                  outcome: run.verdict?.outcome ?? 'COMPLETED',
                  at: run.completedAt ?? new Date(now).toISOString(),
                  runId: run.id,
                  referenceHash: j.definition.entries?.find((e) => e.vectorId === step.vectorId)
                    ?.referenceHash,
                  receivedBps: run.verdict?.target?.avgBps ?? null,
                  acceptedConnections: run.verdict?.connections?.accepted ?? null,
                  drsScoreEligible: false,
                };
              if (run.status === 'FAILED') {
                failed = true;
                step.result ??= {
                  kind: 'NOT_EVALUATED',
                  outcome: 'RUNNER_FAILED',
                  at: new Date(now).toISOString(),
                  runId: run.id,
                  reason: run.error,
                  receivedBps: null,
                  drsScoreEligible: false,
                };
                j.reason ??= run.error;
              }
            }
          const remaining = j.steps.find((s) => !s.runId && !s.result);
          if (!waiting && (j.state === 'STOPPING' || failed || !remaining)) {
            for (const step of j.steps)
              step.result ??= {
                kind: 'NOT_EVALUATED',
                outcome: 'NOT_EXECUTED',
                at: new Date(now).toISOString(),
                reason: j.reason ?? 'Campaign stopped before this scenario',
                receivedBps: null,
                drsScoreEligible: false,
              };
            if (!r.planHash) freeze(r, c);
            if (!r.finalizedAt) finalize(r);
            j.state = j.state === 'STOPPING' ? 'CANCELLED' : failed ? 'FAILED' : 'COMPLETED';
            j.finishedAt = new Date(now).toISOString();
            c.status = j.state === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED';
            c.statusDetail =
              j.reason ?? 'Synthetic sequence completed; DRS evidence remains partial';
            await record(tx, c, 'system', 'Synthetic final report ' + j.state);
          } else if (!waiting && remaining && j.state === 'RUNNING' && now >= (j.nextAt ?? 0)) {
            if (remaining.execution === 'SIMULATION') {
              const entry = j.definition.entries!.find((e) => e.vectorId === remaining.vectorId)!;
              remaining.result = simulateReference(entry, new Date(now).toISOString());
              j.nextAt = now + j.definition.reference.intervalSec * 1000;
              await record(tx, c, 'system', 'Synthetic simulation settled ' + entry.vectorId);
            } else {
              const otherRuns = await tx.listBenchRuns(1, true);
              if (!otherRuns.some((x) => x.status === 'REQUESTED' || x.status === 'CLAIMED')) {
                const run: BenchRun = {
                  id: randomUUID(),
                  scenario: remaining.scenarioId,
                  labTarget: j.definition.labTarget,
                  status: 'REQUESTED',
                  requestedBy: c.createdBy,
                  requestedAt: new Date(now).toISOString(),
                };
                await tx.createBenchRun(run);
                remaining.runId = run.id;
                j.nextAt = undefined;
                await record(
                  tx,
                  c,
                  'system',
                  'Synthetic scenario queued ' + run.scenario + ' ' + run.id,
                );
              }
            }
          }
          await tx.saveCampaign(c);
        });
        const saved = await this.store.getCampaign(id);
        if (!saved?.syntheticJourney || !syntheticActive(saved.syntheticJourney.state))
          this.active.delete(id);
      }
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async close() {
    this.closing = true;
    await this.pending;
  }
}
