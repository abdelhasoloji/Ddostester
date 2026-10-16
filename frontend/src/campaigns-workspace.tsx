import { CampaignManager } from './campaign-manager.js';
import { DrsAssessmentWorkspace } from './drs-assessment-workspace.js';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from './context.js';
import { PageHead, SuiteRunBanner, CampaignLaunch, CampaignList } from './pages.js';
import { GuidePage } from './guide-page.js';
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
  { id: 'manager', label: 'Campaign manager' },
  { id: 'launch', label: 'Launch' },
  { id: 'templates', label: 'Templates' },
  { id: 'evidence', label: 'DRS assessment' },
  { id: 'plan', label: 'Plan' },
  { id: 'guide', label: 'How it works' },
] as const;

export function CampaignsWorkspace() {
  const app = useApp();
  const { refreshHealth } = app;
  // The effective allowlist can change after the initial page load (a target
  // onboarded or authorized in another view/session), so refresh /health when the
  // workspace mounts — the target picker then always offers the current allowed
  // hosts without a full reload.
  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? (app.drsWorkflow ? 'manager' : 'launch');
  const active =
    app.drsWorkflow && !['manager', 'launch', 'templates', 'evidence'].includes(requested)
      ? 'launch'
      : TABS.some((t) => t.id === requested)
        ? requested
        : 'launch';
  const select = (id: string) =>
    setParams(!app.drsWorkflow && id === 'launch' ? {} : { tab: id }, { replace: false });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const visibleTabs = TABS.filter((t) =>
    app.drsWorkflow
      ? ['manager', 'launch', 'templates', 'evidence'].includes(t.id)
      : t.id !== 'manager',
  );
  // WAI-ARIA tabs keyboard model: ←/→ (and Home/End) move between tabs with
  // automatic activation, so the panel follows focus.
  const onTabKey = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % visibleTabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = visibleTabs.length - 1;
    else return;
    e.preventDefault();
    select(visibleTabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <PageHead
        title="Campaigns"
        sub={
          app.drsWorkflow
            ? 'DRS objective · execution chain · campaign control'
            : 'Define, launch and track bounded resilience campaigns.'
        }
      />
      <SuiteRunBanner />

      <div className="ws-tabs" role="tablist" aria-label="Campaigns workspace">
        {visibleTabs.map((t, i) => (
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
            {app.drsWorkflow
              ? t.id === 'manager'
                ? 'Campaign manager'
                : t.id === 'launch'
                  ? 'Single scenario'
                  : t.id === 'templates'
                    ? 'DRS catalogue'
                    : 'DRS assessment'
              : t.label}
          </button>
        ))}
      </div>

      <div className="ws-panel" role="tabpanel" id="ws-panel" aria-labelledby={`ws-tab-${active}`}>
        {active === 'manager' && <CampaignManager />}
        {active === 'launch' && <CampaignLaunch />}
        {active === 'templates' && <TemplatesPage embedded />}
        {active === 'evidence' && <DrsAssessmentWorkspace />}
        {active === 'plan' && <PlanPage embedded />}
        {active === 'guide' && <GuidePage embedded />}
      </div>

      {active === 'manager' ? (
        <details>
          <summary>Other campaigns</summary>
          <CampaignList />
        </details>
      ) : (
        <CampaignList />
      )}
    </>
  );
}
