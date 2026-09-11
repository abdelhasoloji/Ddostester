import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context.js';
import { Login } from './ui.js';
import {
  AuditPage,
  CommandCenterPage,
  Layout,
  ReportsPage,
  RunTheaterPage,
  SettingsPage,
} from './pages.js';
import { CampaignsWorkspace } from './campaigns-workspace.js';
import { PreparationPage } from './preparation-page.js';

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
        <Route index element={<CommandCenterPage />} />
        <Route path="prepare" element={<PreparationPage />} />
        <Route path="campaigns" element={<CampaignsWorkspace />} />
        <Route path="theater" element={<RunTheaterPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {/* Merged into the Campaigns workspace — redirect old paths to the tab. */}
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="templates" element={<Navigate to="/campaigns?tab=templates" replace />} />
        <Route path="plan" element={<Navigate to="/campaigns?tab=plan" replace />} />
        <Route path="guide" element={<Navigate to="/campaigns?tab=guide" replace />} />
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
