import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  type Campaign,
  type DrsCampaignView,
  type FleetDevice,
  type FleetOverview,
} from './api.js';
import { useApp, canDo } from './context.js';
import { HelpTip } from './help-tip.js';
import { Modal } from './modal.js';

/** Read-only configuration admission. Physical baseline/collector qualification remains server-owned. */
export function DrsLaunchReview({ campaign }: { campaign: Campaign }) {
  const app = useApp();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<{
    view: DrsCampaignView;
    fleet: FleetOverview;
    devices: FleetDevice[];
    at: number;
  }>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    setSnapshot(undefined);
    setError('');
    const selected = campaign.fleetDeviceIds ?? [];
    Promise.all([
      api.drsCampaign(campaign.id),
      api.fleetOverview(),
      Promise.all(selected.length <= 3 ? selected.map((id) => api.fleetDevice(id)) : []),
    ])
      .then(([view, fleet, devices]) => {
        if (live) setSnapshot({ view, fleet, devices, at: Date.now() });
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [campaign.id, refresh]);
  const revision = snapshot?.view.document?.revisions.find(
    (r) => r.number === snapshot.view.document?.currentRevision,
  );
  const budgets = revision?.plan.budgets as
    | { maxRps?: number; concurrency?: number; maxAgents?: number; maxDurationSec?: number }
    | undefined;
  const ids = campaign.fleetDeviceIds ?? [];
  const fleet = snapshot?.fleet;
  const issues: string[] = [];
  if (snapshot) {
    if (snapshot.view.archived || campaign.archived) issues.push('Campaign is archived.');
    if (!revision?.planHash || revision.finalizedAt)
      issues.push('Save and freeze an active campaign plan.');
    if (revision?.plan.mode !== 'synthetic-lab' || campaign.drsMode !== 'synthetic-lab')
      issues.push(
        'Only bounded laboratory dispatch is available. Simulation and measured evaluation use separate workflows.',
      );
    if (!['PENDING_APPROVAL', 'APPROVED'].includes(campaign.status))
      issues.push('Campaign is not waiting for execution.');
    if (app.approvalPolicy !== 'confirmation' && campaign.status !== 'APPROVED')
      issues.push('Approval is required before execution.');
    if (app.requireCisoApproval && !campaign.cisoApprovedBy)
      issues.push('CISO sign-off is required before execution.');
    if (!fleet?.enabled) issues.push('Fleet generator is unavailable.');
    let target: URL | undefined;
    let probe: URL | undefined;
    try {
      target = new URL(campaign.target);
      probe = new URL(campaign.probeUrl);
    } catch {
      /* Invalid addresses remain blocked below. */
    }
    if (
      !target ||
      !probe ||
      !app.allowed.includes(target.hostname) ||
      !app.allowed.includes(probe.hostname) ||
      !fleet?.origins.includes(target.origin)
    )
      issues.push('Target or probe permission is missing. Review the authorized scope.');
    if (
      !ids.length ||
      ids.length > 3 ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) =>
        snapshot.devices.some(
          (d) =>
            d.id === id && d.connection === 'online' && d.agentVersion === 'fleet-mission-agent/v1',
        ),
      )
    )
      issues.push(
        'Selected agents are unavailable or not confirmed by the current inventory. Refresh or review the selection.',
      );
    const caps = fleet?.caps;
    if (
      !caps ||
      !budgets ||
      !Number.isFinite(budgets.maxRps) ||
      !Number.isFinite(budgets.concurrency) ||
      !Number.isFinite(budgets.maxAgents) ||
      !Number.isFinite(budgets.maxDurationSec) ||
      campaign.maxRps > Math.min(caps.maxRps, app.hardCaps.maxRps, budgets.maxRps!) ||
      campaign.concurrency >
        Math.min(caps.maxConcurrency, app.hardCaps.maxConcurrency, budgets.concurrency!) ||
      campaign.maxDurationSec >
        Math.min(caps.maxDurationSec, app.hardCaps.maxDurationSec, budgets.maxDurationSec!) ||
      ids.length > budgets.maxAgents! ||
      campaign.maxRps < ids.length ||
      campaign.concurrency < ids.length
    )
      issues.push('Shared budget does not fit the current limits and frozen plan.');
  }
  const fresh = !!snapshot && Date.now() - snapshot.at < 15000 && now - snapshot.at < 15000;
  const allowed =
    fresh &&
    !issues.length &&
    !busy &&
    canDo(app.role, 'execute', app.authRequired, app.userMode, app.capabilities);
  return (
    <Modal
      label="Confirm campaign"
      onClose={() => {
        if (!busy) app.setConfirmExec(null);
      }}
    >
      <h3>Confirm campaign</h3>
      <p className="modal-target">{campaign.target}</p>
      <p>
        <b>{ids.length} agents</b> · <b>{campaign.maxRps} req/s shared</b> ·{' '}
        {campaign.maxDurationSec}s exposure
      </p>
      <p className="hint">
        Baseline first · stop available throughout{' '}
        <HelpTip label="Launch checks">
          The checks below inspect the plan, permissions and fresh Fleet inventory without sending
          campaign traffic. Runtime admission and baseline stability remain mandatory. They do not
          establish independent collector readiness or a measured DRS level.
        </HelpTip>
      </p>
      {error ? (
        <p role="alert">Checks unavailable: {error}</p>
      ) : !snapshot ? (
        <p role="status">Checking plan and Fleet…</p>
      ) : issues.length ? (
        <ul role="alert">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : (
        <p role="status">Configuration checked · baseline health still to be qualified</p>
      )}
      {snapshot && !fresh && <p role="alert">Checks expired. Refresh before confirming.</p>}
      <div className="btn-row">
        <button className="btn" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
          Refresh checks
        </button>
        {issues.length > 0 && (
          <Link
            className="btn"
            to={'/campaigns?tab=evidence&campaign=' + encodeURIComponent(campaign.id)}
            onClick={() => app.setConfirmExec(null)}
          >
            Review campaign plan
          </Link>
        )}
        <button className="btn" disabled={busy} onClick={() => app.setConfirmExec(null)}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!allowed}
          onClick={() => {
            if (!allowed || !fresh) return;
            setBusy(true);
            void app.execute(campaign);
            app.setConfirmExec(null);
            navigate('/theater?run=' + encodeURIComponent(campaign.id));
          }}
        >
          Start campaign
        </button>
      </div>
    </Modal>
  );
}
