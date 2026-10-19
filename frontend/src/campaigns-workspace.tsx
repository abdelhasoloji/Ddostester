import { DrsAssessmentWorkspace } from './drs-assessment-workspace.js';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from './context.js';
import { PageHead, SuiteRunBanner, CampaignLaunch, CampaignList } from './pages.js';
import { HelpTip } from './interface-kit.js';
import { TemplatesPage } from './templates-page.js';

/** Templates are the only creation surface; history and evidence remain separate.
 * Legacy launch/plan/guide links resolve to the template catalogue. */
const TABS = [
  { id: 'templates', label: 'Templates' },
  { id: 'history', label: 'Campaigns' },
  { id: 'evidence', label: 'Assessment' },
] as const;

export function CampaignsWorkspace() {
  const { refreshHealth, drsWorkflow, draftCampaign } = useApp();
  // The effective allowlist can change after the initial page load (a target
  // onboarded or authorized in another view/session), so refresh /health when the
  // workspace mounts — the target picker then always offers the current allowed
  // hosts without a full reload.
  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? 'templates';
  const active = TABS.some((t) => t.id === requested) ? requested : 'templates';
  const configuring =
    (params.get('engine') === 'fleet' && params.get('template') === 'fleet-get') ||
    (drsWorkflow && !!draftCampaign?.drsProfileId);
  const select = (id: string) =>
    setParams(id === 'templates' ? {} : { tab: id }, { replace: false });
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const visibleTabs = TABS;
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
    <div className="campaign-workspace">
      <PageHead title="Campaigns" sub="Choose a template, review and confirm." />
      <div className="workspace-help">
        <HelpTip
          label="Campaign workflow"
          text="Start from a template. Existing campaigns are in Campaigns; evidence and scoring are in Assessment. Creation never starts traffic automatically."
        />
      </div>
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
            {t.label}
          </button>
        ))}
      </div>

      <div className="ws-panel" role="tabpanel" id="ws-panel" aria-labelledby={`ws-tab-${active}`}>
        {active === 'templates' && (configuring ? <CampaignLaunch /> : <TemplatesPage embedded />)}
        {active === 'history' && <CampaignList />}
        {active === 'evidence' && <DrsAssessmentWorkspace />}
      </div>
    </div>
  );
}
