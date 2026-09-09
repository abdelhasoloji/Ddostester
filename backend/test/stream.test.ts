import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { initAuth } from '../src/auth/guard.js';
import { createCampaign, approveCampaign } from '../src/modules/campaigns/service.js';
import { liveProgress } from '../src/runtime/live.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const ALLOWED = ['127.0.0.1'];
const base: CampaignInput = {
  name: 'Stream test',
  target: 'http://127.0.0.1/',
  vector: 'http-get',
  maxRps: 50,
  concurrency: 5,
  maxDurationSec: 30,
  probeUrl: 'http://127.0.0.1/',
  createdBy: 'eng@wedos',
  authorized: true,
};

/** Read a (possibly infinite) SSE stream for up to `ms`, then abort and return the text. */
async function readFor(url: string, ms: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let text = '';
  try {
    const res = await fetch(url, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
  } catch {
    /* aborted (for a still-running stream) — return what we captured */
  } finally {
    clearTimeout(timer);
  }
  return text;
}

describe('GET /api/campaigns/:id/stream', () => {
  let app: FastifyInstance;
  let baseUrl = '';
  const ids = { approved: '', rejected: '', running: '' };

  beforeAll(async () => {
    const store = new MemoryStore();
    // Non-terminal (APPROVED), never run → no live-progress record.
    const approved = approveCampaign(createCampaign(base, ALLOWED), 'off@wedos', 'APPROVED');
    await store.saveCampaign(approved);
    ids.approved = approved.id;
    // Terminal (REJECTED).
    const rejected = approveCampaign(createCampaign(base, ALLOWED), 'off@wedos', 'REJECTED', 'no');
    await store.saveCampaign(rejected);
    ids.rejected = rejected.id;
    // RUNNING with a seeded live-progress record (as runCampaign seeds it).
    const running = { ...createCampaign(base, ALLOWED), status: 'RUNNING' as const };
    await store.saveCampaign(running);
    ids.running = running.id;
    liveProgress.set(running.id, {
      sent: 10,
      successful: 9,
      failed: 1,
      elapsedSec: 2,
      actualRps: 5,
      maxDurationSec: 30,
      status: 'RUNNING',
      engine: 'builtin-http',
    });

    app = (
      await buildApp({
        store,
        auth: initAuth({} as NodeJS.ProcessEnv),
        allowedTargets: ALLOWED,
        logger: false,
        serveStatic: false,
      })
    ).app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    liveProgress.clear(ids.running);
    await app.close();
  });

  it('keeps a non-terminal campaign alive with "waiting" (never a premature "done")', async () => {
    const text = await readFor(`${baseUrl}/api/campaigns/${ids.approved}/stream`, 1400);
    expect(text).toContain('"status":"waiting"');
    // The whole point of the fix: a running-but-not-yet-reporting campaign must
    // NOT be told the stream is done.
    expect(text).not.toContain('"status":"done"');
  });

  it('streams the live progress for a RUNNING campaign', async () => {
    const text = await readFor(`${baseUrl}/api/campaigns/${ids.running}/stream`, 1200);
    expect(text).toContain('"status":"RUNNING"');
    expect(text).toContain('"actualRps":5');
    expect(text).not.toContain('"status":"done"');
  });

  it('closes with "done" once the campaign is terminal', async () => {
    const text = await readFor(`${baseUrl}/api/campaigns/${ids.rejected}/stream`, 3000);
    expect(text).toContain('"status":"done"');
  });
});
