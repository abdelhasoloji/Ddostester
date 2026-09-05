import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context.js';
import { Login } from './ui.js';
import {
  AuditPage,
  CampaignsPage,
  Layout,
  OverviewPage,
  ReportsPage,
  SettingsPage,
} from './pages.js';

/**
 * Portail d'authentification : tant que l'auth est activée et que l'opérateur
 * n'est pas connecté, on affiche l'écran de connexion (avec la barre d'accent
 * WEDOS) au lieu de l'application routée.
 */
function Gate() {
  const app = useApp();
  if (!app.authChecked) {
    return (
      <div className="app">
        <p className="hint" style={{ margin: '2rem' }}>
          Chargement…
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
        <Route index element={<OverviewPage />} />
        <Route path="campagnes" element={<CampaignsPage />} />
        <Route path="rapports" element={<ReportsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="parametres" element={<SettingsPage />} />
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
