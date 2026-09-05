import { createStore } from './store/index.js';
import { initAuth } from './auth/guard.js';
import { kills } from './runtime/kills.js';
import { dueCampaigns } from './modules/campaigns/scheduler.js';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);
// Adresse d'écoute. Défaut : loopback uniquement — l'outil ne doit JAMAIS être
// exposé publiquement sans reverse-proxy TLS/mTLS. Accès distant via tunnel SSH.
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_TARGETS = (process.env.ALLOWED_TARGETS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SCHEDULER = (process.env.SCHEDULER ?? 'on') !== 'off';
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);

const store = await createStore();
const auth = initAuth();
const { app, runCampaign } = await buildApp({ store, auth, allowedTargets: ALLOWED_TARGETS });

// --- Ordonnanceur (CAM-01) : exécute les campagnes planifiées échues ---------
if (SCHEDULER) {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const campaigns = await store.listCampaigns();
      for (const c of dueCampaigns(campaigns, Date.now())) {
        if (kills.get(c.id)) continue; // déjà en cours
        app.log.info(`ordonnanceur : exécution planifiée de ${c.id}`);
        try {
          await runCampaign(c, 'scheduler');
        } catch (err) {
          app.log.error({ err }, `échec exécution planifiée ${c.id}`);
        }
      }
    } catch (err) {
      app.log.error({ err }, 'échec tick ordonnanceur');
    } finally {
      ticking = false;
    }
  }, SCHEDULER_INTERVAL_MS).unref();
}

app
  .listen({ port: PORT, host: HOST })
  .then((addr) =>
    app.log.info(
      `ShieldTest control plane sur ${addr} — stockage: ${store.backend} — ordonnanceur: ${SCHEDULER ? 'on' : 'off'} — cibles: ${ALLOWED_TARGETS.join(', ')}`,
    ),
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
