import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context.js';
import { Login, ForcedPasswordChange } from './ui.js';
import {
  CommandCenterPage,
  Layout,
  ReportsPage,
  RunTheaterPage,
  SettingsPage,
  AccountPage,
} from './pages.js';
import { CampaignsWorkspace } from './campaigns-workspace.js';
import { ZonesPage } from './zones-page.js';

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
  // Admin-set temporary password: block the app until it's changed.
  if (app.authRequired && app.identity && app.mustChangePassword) {
    return <ForcedPasswordChange />;
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CommandCenterPage />} />
        <Route path="zones" element={<ZonesPage />} />
        <Route path="campaigns" element={<CampaignsWorkspace />} />
        <Route path="theater" element={<RunTheaterPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="account" element={<AccountPage />} />
        {/* Bookmark-compat: old paths folded into their live home. */}
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="templates" element={<Navigate to="/campaigns?tab=templates" replace />} />
        <Route path="plan" element={<Navigate to="/campaigns?tab=plan" replace />} />
        <Route path="guide" element={<Navigate to="/campaigns?tab=guide" replace />} />
        {/* Prepare is superseded by the recon-first create flow; the audit log
            now lives inside Settings. Keep the URLs working for bookmarks. */}
        <Route path="prepare" element={<Navigate to="/campaigns" replace />} />
        <Route path="audit" element={<Navigate to="/settings" replace />} />
        {/* Unknown URL → home, so the shell never shows a blank content area. */}
        <Route path="*" element={<Navigate to="/" replace />} />
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
