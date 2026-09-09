import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context.js';
import { Login } from './ui.js';
import {
  AuditPage,
  CampaignsPage,
  GuidePage,
  Layout,
  OverviewPage,
  ReportsPage,
  SettingsPage,
} from './pages.js';
import { TemplatesPage } from './templates-page.js';
import { PreparationPage } from './preparation-page.js';
import { PlanPage } from './plan-page.js';

/**
 * Authentication gate: while auth is enabled and the operator is not signed in,
 * show the sign-in screen (with the WEDOS accent bar) instead of the routed app.
 */
function Gate() {
  const app = useApp();
  if (!app.authChecked) {
    return (
      <div className="app">
        <p className="hint" style={{ margin: '2rem' }}>
          Loading…
        </p>
      </div>
    );
  }
  if (app.authRequired && !app.identity) {
    return (
      <>
        <div className="accent-line" />
        <div className="app">
          <Login />
        </div>
      </>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CampaignsPage />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="prepare" element={<PreparationPage />} />
        <Route path="plan" element={<PlanPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="guide" element={<GuidePage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AppProvider>
  );
}
