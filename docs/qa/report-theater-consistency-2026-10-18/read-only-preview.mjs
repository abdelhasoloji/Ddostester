// Presentation replay of the measured local journey; all mutations are refused.
import { readFile } from 'node:fs/promises';
import { buildApp } from '../../../backend/dist/app.js';
import { MemoryStore } from '../../../backend/dist/store/memory.js';
import { initAuth } from '../../../backend/dist/auth/guard.js';
const store = new MemoryStore();
const campaign = JSON.parse(await readFile(new URL('./local-campaign.json', import.meta.url)));
const run = JSON.parse(await readFile(new URL('./observed-run.json', import.meta.url)));
if (campaign.status !== 'COMPLETED' || campaign.runId !== run.runId)
  throw Error('Invalid replay fixture');
await store.saveCampaign(campaign);
await store.saveRun(run);
const { app } = await buildApp({
  store,
  auth: initAuth({ USER_MODE: 'team' }),
  allowedTargets: ['127.0.0.1'],
  logger: false,
  serveStatic: true,
});
app.addHook('onRequest', async (req, reply) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
    return reply
      .code(403)
      .send({ error: 'Retained-evidence replay: execution and mutations disabled.' });
});
await app.listen({ host: '127.0.0.1', port: 18110 });
console.log('Read-only retained-evidence replay ready.');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
