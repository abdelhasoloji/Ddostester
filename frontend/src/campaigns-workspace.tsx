import { useSearchParams } from 'react-router-dom';
import { PageHead, SuiteRunBanner, CampaignLaunch, CampaignList, GuidePage } from './pages.js';
import { TemplatesPage } from './templates-page.js';
import { PlanPage } from './plan-page.js';

/**
 * Campaigns workspace — the single home for everything that turns an intent into
 * a governed campaign. One tabbed surface (Launch / Templates / Plan / How it
 * works) over the persistent campaign list, so the rich template catalogue, the
 * DRS replay plan and the guide all live where campaigns are created — instead
 * of scattered, thinner screens. The active tab is URL-driven (`?tab=`) so every
 * entry point (guide, recon → plan, deep links) lands on the right surface.
 */
const TABS = [
  { id: 'launch', label: 'Launch' },
  { id: 'templates', label: 'Templates' },
  { id: 'plan', label: 'Plan' },
  { id: 'guide', label: 'How it works' },
] as const;

export function CampaignsWorkspace() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? 'launch';
  const active = TABS.some((t) => t.id === requested) ? requested : 'launch';
  const select = (id: string) => setParams(id === 'launch' ? {} : { tab: id }, { replace: false });

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Define, launch and track bounded resilience campaigns — guided, straight from a template, or from a recon-seeded replay plan."
      />
      <SuiteRunBanner />

      <div className="ws-tabs" role="tablist" aria-label="Campaigns workspace">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            className={`ws-tab${active === t.id ? ' active' : ''}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ws-panel" role="tabpanel">
        {active === 'launch' && <CampaignLaunch />}
        {active === 'templates' && <TemplatesPage embedded />}
        {active === 'plan' && <PlanPage embedded />}
        {active === 'guide' && <GuidePage embedded />}
      </div>

      <CampaignList />
    </>
  );
}
