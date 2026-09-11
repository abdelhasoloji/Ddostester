import { useRef } from 'react';
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // WAI-ARIA tabs keyboard model: ←/→ (and Home/End) move between tabs with
  // automatic activation, so the panel follows focus.
  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    select(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Define, launch and track bounded resilience campaigns — guided, straight from a template, or from a recon-seeded replay plan."
      />
      <SuiteRunBanner />

      <div className="ws-tabs" role="tablist" aria-label="Campaigns workspace">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            id={`ws-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-controls="ws-panel"
            tabIndex={active === t.id ? 0 : -1}
            className={`ws-tab${active === t.id ? ' active' : ''}`}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ws-panel" role="tabpanel" id="ws-panel" aria-labelledby={`ws-tab-${active}`}>
        {active === 'launch' && <CampaignLaunch />}
        {active === 'templates' && <TemplatesPage embedded />}
        {active === 'plan' && <PlanPage embedded />}
        {active === 'guide' && <GuidePage embedded />}
      </div>

      <CampaignList />
    </>
  );
}
