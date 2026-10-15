#!/usr/bin/env node
import assert from 'node:assert/strict';

// Execute inside an isolated checker Pod. Never accept an Internet endpoint.
function privateOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.ok(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname));
  assert.ok(url.hostname.split('.').every((part) => Number(part) <= 255));
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  return url.origin;
}
const prometheus = privateOrigin(process.env.LAB_PROMETHEUS_ORIGIN);
const grafana = privateOrigin(process.env.LAB_GRAFANA_ORIGIN);
assert.ok(process.env.LAB_GRAFANA_PASSWORD?.length >= 32);
const auth = `Basic ${Buffer.from(`lab-admin:${process.env.LAB_GRAFANA_PASSWORD}`).toString('base64')}`;
async function get(origin, path, authorization) {
  const response = await fetch(origin + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: authorization ? { authorization } : {},
  });
  assert.equal(response.status, 200, `HTTP status for ${path}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= 2 * 1024 * 1024, 'Response size');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}
const targets = await get(prometheus, '/api/v1/targets');
assert.equal(targets.status, 'success');
for (const job of ['lab-control', 'lab-prometheus', 'lab-target-receipts']) {
  const matching = targets.data.activeTargets.filter((target) => target.labels.job === job);
  assert.equal(matching.length, 1, `Target count for ${job}`);
  assert.equal(matching[0].health, 'up', `Scrape for ${job}`);
}
const query = await get(prometheus, '/api/v1/query?query=up%7Bjob%3D%22lab-control%22%7D');
assert.equal(query.status, 'success');
assert.equal(query.data.result.length, 1);
assert.equal(query.data.result[0].value[1], '1');
const health = await get(grafana, '/api/health');
assert.equal(health.database, 'ok');
const anonymous = await fetch(grafana + '/api/user', {
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
});
assert.equal(anonymous.status, 401);
const user = await get(grafana, '/api/user', auth);
assert.equal(user.login, 'lab-admin');
const datasource = await get(grafana, '/api/datasources/uid/prometheus', auth);
assert.equal(datasource.type, 'prometheus');
assert.equal(datasource.url, 'http://lab-prometheus:9090');
for (const uid of [
  'shieldtest-run',
  'shieldtest-resilience',
  'shieldtest-fleet',
  'shieldtest-http-receipts',
]) {
  const dashboard = await get(grafana, `/api/dashboards/uid/${uid}`, auth);
  assert.equal(dashboard.dashboard.uid, uid);
  assert.ok(dashboard.dashboard.panels.length > 0);
}
console.log(
  JSON.stringify({
    kind: 'private-lab-monitoring-proof',
    scrapeTargetsUp: 3,
    controlUp: true,
    grafanaDatabaseHealthy: true,
    anonymousRejected: true,
    adminAuthenticated: true,
    provisionedDatasource: true,
    provisionedDashboards: 4,
  }),
);
