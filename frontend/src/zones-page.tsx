import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import type { ZoneSummary } from './api.js';
import { PageHead } from './pages.js';
import { wrsClass } from './ui.js';

/**
 * Protected zones — the WEDOS-Protection framing: the estate seen per protected
 * customer/host, each with its assurance posture (WRS, DRS reached, edge
 * absorption, activity). Derived from the existing campaigns; a zone is the unit
 * WEDOS Protection is sold and measured by. See docs/vision-proving-ground.md.
 */
function fmtWhen(iso?: string): string {
  if (!iso) return 'never tested';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never tested';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function ZoneCard({ z, onOpen }: { z: ZoneSummary; onOpen: () => void }) {
  const status = z.running
    ? { cls: 'zs-live', label: '● testing' }
    : z.regression
      ? { cls: 'zs-bad', label: '▼ regression' }
      : z.lastLevel && ['A+', 'A', 'B'].includes(z.lastLevel)
        ? { cls: 'zs-ok', label: '✓ resilient' }
        : z.lastWrs != null
          ? { cls: 'zs-warn', label: 'needs attention' }
          : { cls: 'zs-none', label: 'not tested' };
  return (
    <button type="button" className="zone-card" onClick={onOpen} aria-label={`Open ${z.host}`}>
      <div className="zone-head">
        <span className="zone-host">🛡 {z.host}</span>
        <span className={`zone-status ${status.cls}`}>{status.label}</span>
      </div>
      <div className="zone-wrs">
        {z.lastWrs != null ? (
          <span className={`wrs ${wrsClass((z.lastLevel ?? 'C') as never)}`} title="Latest WRS">
            <span className="wrs-score">{z.lastWrs}</span> {z.lastLevel}
          </span>
        ) : (
          <span className="hint">No score yet</span>
        )}
        {z.meanWrs != null && z.lastWrs != null && <span className="hint">avg {z.meanWrs}</span>}
      </div>
      <dl className="zone-meta">
        <div>
          <dt>DRS reached</dt>
          <dd>{z.maxDrs != null ? `DRS ${z.maxDrs}` : '—'}</dd>
        </div>
        <div>
          <dt>Edge absorbed</dt>
          <dd>{z.lastAbsorbedPct != null ? `${z.lastAbsorbedPct}%` : '—'}</dd>
        </div>
        <div>
          <dt>Campaigns</dt>
          <dd>
            {z.campaigns}
            {z.suites > 0 ? ` · ${z.suites} suite${z.suites === 1 ? '' : 's'}` : ''}
          </dd>
        </div>
      </dl>
      <div className="zone-foot hint">Last test: {fmtWhen(z.lastTestAt)}</div>
    </button>
  );
}

export function ZonesPage() {
  const navigate = useNavigate();
  const [zones, setZones] = useState<ZoneSummary[] | null>(null);
  useEffect(() => {
    api
      .zones()
      .then(setZones)
      .catch(() => setZones([]));
  }, []);

  return (
    <>
      <PageHead
        title="Protected zones"
        sub="Assurance per protected customer — how well the WEDOS edge holds for each host, at a glance. A zone is a target under test; open one to see its campaigns."
      />
      {zones === null ? (
        <p className="hint">
          <span className="spin" /> Loading zones…
        </p>
      ) : zones.length === 0 ? (
        <div className="empty">
          No protected zones yet — run a campaign against a target and it appears here.
        </div>
      ) : (
        <div className="zones-grid">
          {zones.map((z) => (
            <ZoneCard
              key={z.host}
              z={z}
              onOpen={() => navigate(`/campaigns?q=${encodeURIComponent(z.host)}`)}
            />
          ))}
        </div>
      )}
    </>
  );
}
