import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from './context.js';
import { emptyForm } from './campaign-form.js';
import { applyLevers, type LeverId } from './recon-first-create.js';
import type { Campaign, CampaignRun, RunMechanism } from './api.js';

/**
 * The adaptive feedback loop: turn a COMPLETED run's conclusions — the detected
 * countermeasures (posture) and how the edge defended (assessment mechanism +
 * verdict) — into a seeded follow-up campaign that takes them into account.
 *
 * This is the post-run counterpart to recon's `suggestFromRecon`/`deriveLevers`
 * (which only look at pre-run recon): it reads what the target ACTUALLY did under
 * load and proposes the next scenario. Pure, so it is unit-tested. It only ever
 * proposes a seed the operator reviews and re-submits for approval — it never
 * launches anything, and every value still passes the form's HARD_CAPS clamp.
 */
export interface ReplaySuggestion {
  seed: Partial<typeof emptyForm>;
  levers: LeverId[];
  /** One-line summary of what the follow-up changes. */
  headline: string;
  /** Why — one plain sentence per adaptation, keyed to what was observed. */
  rationale: string[];
}

export const LEVER_LABEL: Record<LeverId, string> = {
  cacheBust: 'Cache-busting',
  calibrate: 'Auto-calibrate',
  rotateUa: 'UA rotation',
  noKeepAlive: 'No keep-alive',
};

export function suggestFromRun(campaign: Campaign, run: CampaignRun): ReplaySuggestion {
  const a = run.assessment;
  const posture = run.posture;
  const mechanism: RunMechanism = a?.mechanism ?? 'unknown';
  const rationale: string[] = [];
  const leverSet = new Set<LeverId>();

  // Base: carry the target/probe/vector/shape from the original campaign.
  const base: Partial<typeof emptyForm> = {
    name: `${campaign.name} · replay`,
    target: campaign.target,
    probeUrl: campaign.probeUrl,
    referenceUrl: campaign.referenceUrl ?? '',
    vector: campaign.vector,
    maxRps: campaign.maxRps,
    concurrency: campaign.concurrency,
    maxDurationSec: campaign.maxDurationSec,
    profile: 'constant',
  };

  // Posture-driven levers — the same mapping recon uses, but read from what the
  // run actually faced.
  if (posture?.cdn) {
    leverSet.add('cacheBust');
    rationale.push(
      'A CDN fronted the target — cache-busting so every request reaches the origin, not a cached copy.',
    );
  }
  if (posture?.rateLimiting) {
    leverSet.add('calibrate');
    rationale.push(
      'A rate-limiter was detected — auto-calibrate to grade at the deliverable rate.',
    );
  }
  if (posture?.waf) {
    leverSet.add('rotateUa');
    rationale.push('A WAF was detected — rotate User-Agents to exercise signature filtering.');
  }

  // Mechanism-driven shape/config — how the edge defended sets the next move.
  let headline: string;
  switch (mechanism) {
    case 'rejected':
      base.profile = 'ramp';
      leverSet.add('calibrate');
      headline = 'Ramp to the rejection knee, calibrated';
      rationale.push(
        'The edge rejected requests (4xx/5xx) — ramp to find where the limiter/WAF engages, grading at the deliverable rate.',
      );
      break;
    case 'tarpitted': {
      base.profile = 'constant';
      base.concurrency = Math.max(5, Math.round(campaign.concurrency / 2));
      leverSet.add('calibrate');
      headline = 'Lower concurrency to measure the tarpit ceiling';
      rationale.push(
        `The edge tarpitted (held connections to timeout) — halve concurrency (${campaign.concurrency}→${base.concurrency}) and calibrate to measure the sustainable hold without self-saturating.`,
      );
      break;
    }
    case 'shed':
      headline = 'Probe the connection-shed threshold';
      rationale.push(
        'Connections were shed (a slow-request timeout engaged) — replay to find the shed threshold.',
      );
      break;
    case 'blocked':
      leverSet.add('rotateUa');
      leverSet.add('cacheBust');
      headline = 'Vary the fingerprint to test the block';
      rationale.push(
        'Traffic was blocked (challenge / WAF) — rotate User-Agents and cache-bust to vary the request fingerprint.',
      );
      break;
    case 'served':
      base.profile = 'ramp';
      headline = 'Escalate — the origin absorbed this load';
      rationale.push(
        `The origin served the load (only ${run.absorption?.absorbedPct ?? 0}% absorbed by the edge) — ramp toward the peak to find where protection actually engages.`,
      );
      break;
    default:
      headline = 'Replay with the observed posture applied';
      rationale.push(
        'No decisive defense mechanism was measured — replaying with the detected posture’s levers applied.',
      );
  }

  // Under-delivery is independent of mechanism: if we couldn't even offer the
  // configured rate, calibrate so the next verdict is graded at what lands.
  if (a?.underDelivered) {
    leverSet.add('calibrate');
    rationale.push(
      `The run under-delivered (${Math.round((a.deliveryRatio ?? 0) * 100)}% of the configured rate) — calibrate so the next verdict is graded at what actually lands.`,
    );
  }

  const levers = [...leverSet];
  const on = {
    cacheBust: leverSet.has('cacheBust'),
    calibrate: leverSet.has('calibrate'),
    rotateUa: leverSet.has('rotateUa'),
    noKeepAlive: leverSet.has('noKeepAlive'),
  };
  return { seed: applyLevers(base, on), levers, headline, rationale };
}

/**
 * The "Replay accounting for detected countermeasures" CTA, shown on a completed
 * run's detail. Expands to explain what the follow-up changes and why, then
 * queues the seed and jumps to the (recon-first) Launch surface with the form
 * pre-filled — the operator reviews and submits it for approval like any campaign.
 */
export function ReplayFromRun({ campaign, run }: { campaign: Campaign; run: CampaignRun }) {
  const app = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Nothing to adapt from until the run produced a conclusion.
  if (!run.assessment && !run.posture) return null;
  const s = suggestFromRun(campaign, run);
  const launch = () => {
    app.queueReplay(s.seed);
    app.setExpanded(null); // close the drawer we launched from
    navigate('/campaigns?tab=launch');
  };
  return (
    <div className="replay-cta">
      <button
        className="btn btn-sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Seed a follow-up campaign that adapts to the countermeasures this run detected"
      >
        ↻ Replay accounting for countermeasures
      </button>
      {open && (
        <div className="replay-panel">
          <div className="replay-headline">{s.headline}</div>
          <ul className="replay-why">
            {s.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {s.levers.length > 0 && (
            <div className="replay-levers">
              {s.levers.map((l) => (
                <span key={l} className="chip chip-active">
                  {LEVER_LABEL[l]}
                </span>
              ))}
            </div>
          )}
          <button className="btn btn-sm btn-primary" onClick={launch}>
            Compose this follow-up →
          </button>
        </div>
      )}
    </div>
  );
}
