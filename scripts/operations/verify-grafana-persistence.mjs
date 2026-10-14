#!/usr/bin/env node
import assert from 'node:assert/strict';
const origin = new URL(process.env.LAB_GRAFANA_ORIGIN);
assert.equal(origin.protocol, 'http:');
assert.ok(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(origin.hostname));
assert.ok(origin.hostname.split('.').every((part) => Number(part) <= 255));
assert.equal(origin.username + origin.password + origin.search + origin.hash, '');
assert.equal(origin.pathname, '/');
const marker = process.env.LAB_PERSISTENCE_MARKER;
assert.ok(/^ddostester-persistence-[a-f0-9-]{36}$/.test(marker));
const phase = process.env.LAB_PERSISTENCE_PHASE;
assert.ok(['create', 'verify', 'cleanup'].includes(phase));
assert.ok(process.env.LAB_GRAFANA_PASSWORD?.length >= 32);
const authorization = `Basic ${Buffer.from(`lab-admin:${process.env.LAB_GRAFANA_PASSWORD}`).toString('base64')}`;
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { authorization, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 200, `HTTP status for ${method} ${path}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= 2 * 1024 * 1024);
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const listPath = `/api/annotations?tags=${encodeURIComponent(marker)}&limit=8`;
const entries = await request(listPath);
assert.ok(Array.isArray(entries));
let id;
if (phase === 'create') {
  assert.equal(entries.length, 0, 'Do not duplicate an existing persistence marker');
  const created = await request('/api/annotations', 'POST', {
    time: Date.now(),
    tags: [marker],
    text: marker,
  });
  id = created.id;
  assert.ok(Number.isSafeInteger(id) && id > 0);
  const stored = await request(listPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, id);
  assert.equal(stored[0].text, marker);
} else {
  id = Number(process.env.LAB_PERSISTENCE_ANNOTATION_ID);
  assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, id);
  assert.equal(entries[0].text, marker);
  assert.ok(entries[0].tags.includes(marker));
  if (phase === 'cleanup') {
    await request(`/api/annotations/${id}`, 'DELETE');
    assert.equal((await request(listPath)).length, 0);
  }
}
console.log(
  JSON.stringify({ kind: 'grafana-persistence-marker', phase, id, marker, verified: true }),
);
