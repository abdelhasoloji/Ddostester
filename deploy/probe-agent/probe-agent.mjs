#!/usr/bin/env node
/**
 * WEDOS ShieldTest — remote probe agent (read-only availability vantage).
 *
 * Runs on a SEPARATE host from the control plane (e.g. VPS2) so a resilience
 * campaign can measure the target's availability from a DIFFERENT source IP than
 * the load generator — needed when the target rate-limits by source IP. It is
 * strictly defensive and deliberately minimal:
 *   • ONE bounded GET per request, to an allowlisted host only.
 *   • No load generation, no method/body forwarding, no other routes.
 *   • Bearer-token auth, small per-request timeout, a simple rate cap.
 *
 * Zero dependencies (Node ≥ 20 global fetch + http). Bind it to the tailnet
 * interface (PROBE_AGENT_BIND=<tailscale IP>) so it is never publicly reachable.
 *
 * Env:
 *   PROBE_AGENT_TOKEN      (required) bearer token the control plane must present
 *   PROBE_AGENT_ALLOWLIST  (required) comma-separated hostnames it may GET
 *   PROBE_AGENT_BIND       bind address           (default 127.0.0.1)
 *   PROBE_AGENT_PORT       listen port            (default 8099)
 *   PROBE_AGENT_MAX_TIMEOUT_MS  hard per-GET cap  (default 15000)
 *   PROBE_AGENT_RATE_PER_SEC    max /probe req/s  (default 20)
 *   PROBE_AGENT_MAX_BODY_SLICE  error-body bytes  (default 20000)
 *
 * Request:  POST /probe  { "url": "https://host/path", "timeoutMs": 8000 }
 * Response: 200 { ok, status, latencyMs, headers, bodySlice? }
 *           GET /health → 200 { ok:true } (no auth)
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { beginProbeQuality } from './quality.mjs';

const TOKEN = (process.env.PROBE_AGENT_TOKEN ?? '').trim();
const ALLOWLIST = new Set(
  (process.env.PROBE_AGENT_ALLOWLIST ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const BIND = (process.env.PROBE_AGENT_BIND ?? '127.0.0.1').trim();
const PORT = Number(process.env.PROBE_AGENT_PORT ?? 8099);
const MAX_TIMEOUT_MS = Number(process.env.PROBE_AGENT_MAX_TIMEOUT_MS ?? 15000);
const RATE_PER_SEC = Number(process.env.PROBE_AGENT_RATE_PER_SEC ?? 20);
const MAX_RESPONSE_BYTES = Number(process.env.PROBE_AGENT_MAX_RESPONSE_BYTES ?? 512 * 1024);
const MAX_BODY_SLICE = Number(process.env.PROBE_AGENT_MAX_BODY_SLICE ?? 20000);
const MAX_IN_FLIGHT = Number(process.env.PROBE_AGENT_MAX_IN_FLIGHT ?? 2);
if (!Number.isSafeInteger(MAX_IN_FLIGHT) || MAX_IN_FLIGHT < 1 || MAX_IN_FLIGHT > 4)
  throw new Error('Probe concurrency must be between 1 and 4');
let inFlight = 0;

if (!TOKEN || TOKEN.length < 16) {
  console.error('probe-agent: PROBE_AGENT_TOKEN is required (>= 16 chars). Refusing to start.');
  process.exit(1);
}
if (ALLOWLIST.size === 0) {
  console.error(
    'probe-agent: PROBE_AGENT_ALLOWLIST is required (comma-separated hosts). Refusing to start.',
  );
  process.exit(1);
}

/** Stream with a byte budget; never buffer the whole response before slicing. */
async function readResponseBody(body, limit, capture) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let bytes = 0;
  let captured = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response too large');
      }
      if (capture && captured < limit) {
        const chunk = value.slice(0, limit - captured);
        chunks.push(chunk);
        captured += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(capture ? captured : 0);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
for (const value of [PORT, MAX_TIMEOUT_MS, RATE_PER_SEC, MAX_BODY_SLICE, MAX_RESPONSE_BYTES]) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid probe-agent limit');
}
if (
  PORT > 65535 ||
  MAX_TIMEOUT_MS > 60000 ||
  RATE_PER_SEC > 20 ||
  MAX_BODY_SLICE > 32768 ||
  MAX_RESPONSE_BYTES > 1048576
)
  throw new Error('Probe-agent limit exceeds its bounded laboratory envelope');

/** Constant-time bearer check. */
function authOk(header) {
  const m = /^Bearer\s+(.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Coarse fixed-window rate limit on /probe (per whole second).
let windowSec = 0;
let windowCount = 0;
function rateOk() {
  const now = Math.floor(Date.now() / 1000);
  if (now !== windowSec) {
    windowSec = now;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount <= RATE_PER_SEC;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cap = 4096) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
      req.destroy();
    }, 2000);
    let raw = '';
    let over = false;
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > cap) {
        over = true;
        raw = '';
        return;
      }
      if (!over) raw += c;
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(over ? null : raw);
    });
    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    req.on('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function handleProbe(req, res) {
  if (!authOk(req.headers['authorization'])) return send(res, 401, { error: 'unauthorized' });
  if (!rateOk()) return send(res, 429, { error: 'rate limited' });
  if (inFlight >= MAX_IN_FLIGHT) return send(res, 429, { error: 'probe capacity exceeded' });
  inFlight++;
  try {
    return await measureProbe(req, res);
  } finally {
    inFlight--;
  }
}

async function measureProbe(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const versioned = body?.schema !== undefined || body?.requestId !== undefined;
  if (versioned && (body.schema !== 'ddostester.probe.request/v2' || typeof body.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(body.requestId)))
    return send(res, 400, { error: 'invalid probe request envelope' });
  const envelope = () => versioned ? {schema: 'ddostester.probe.response/v2', requestId: body.requestId, observedAt: new Date().toISOString()} : {};
  const target = body && typeof body.url === 'string' ? body.url : '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return send(res, 400, { error: 'invalid url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return send(res, 400, { error: 'only http/https' });
  }
  if (parsed.username || parsed.password)
    return send(res, 400, { error: 'embedded credentials forbidden' });
  if (!ALLOWLIST.has(parsed.hostname.toLowerCase())) {
    return send(res, 403, { error: `host not allowlisted: ${parsed.hostname}` });
  }
  const timeoutMs = Math.min(
    Math.max(1000, Number(body?.timeoutMs) || MAX_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const finishQuality = await beginProbeQuality();
  const t0 = performance.now();
  try {
    // Strictly a bounded GET — never forward the caller's method or body.
    const r = await fetch(parsed.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: { 'user-agent': 'WEDOS-ShieldTest-probe-agent' },
      redirect: 'manual',
    });
    const latencyMs = performance.now() - t0; // TTFB
    const headers = {};
    r.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let bodySlice;
    if (r.status >= 400) {
      const buf = await readResponseBody(r.body, MAX_BODY_SLICE, true);
      if (buf) {
        const slice = buf.byteLength > MAX_BODY_SLICE ? buf.slice(0, MAX_BODY_SLICE) : buf;
        bodySlice = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      }
    } else {
      await readResponseBody(r.body, MAX_BODY_SLICE, false); // drain to free the socket
    }
    send(res, 200, {
      ok: r.ok,
      status: r.status,
      latencyMs: Math.round(latencyMs),
      quality: await finishQuality(),
      ...envelope(),
      headers,
      ...(bodySlice ? { bodySlice } : {}),
    });
  } catch {
    // A timeout / network failure is a legitimate "unavailable" measurement.
    send(res, 200, {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - t0),
      quality: await finishQuality(),
      ...envelope(),
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'probe-agent', protocols: ['ddostester.probe.request/v2'] });
  }
  if (req.method === 'POST' && (req.url === '/probe' || req.url?.startsWith('/probe?'))) {
    return void handleProbe(req, res);
  }
  send(res, 404, { error: 'not found' });
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.maxConnections = 64;

server.listen(PORT, BIND, () => {
  console.log(
    `probe-agent listening on ${BIND}:${PORT} · allowlist=[${[...ALLOWLIST].join(', ')}] · ` +
      `maxTimeout=${MAX_TIMEOUT_MS}ms · rate=${RATE_PER_SEC}/s`,
  );
});
