import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { TargetNotAllowedError, InvalidConfigError } from './loadTest.js';
import type { LoadTestConfig, LoadTestResult } from './types.js';
import type { LoadProgress } from './loadTest.js';

/**
 * Bounded slow-header ("SlowLoris") vector for the built-in engine.
 *
 * It opens up to `concurrency` connections to the allowlisted target and holds
 * them open with a partial, never-completed request, trickling one benign
 * header line per interval. It measures whether the target SHEDS these slow /
 * incomplete requests (a request/header timeout — good) or lets them accumulate
 * and exhaust its connection pool (bad).
 *
 * This is not an exploit and not amplification: real source, no spoofing, only
 * incomplete but well-formed HTTP, and it is bounded on every axis —
 *   - connection count  ≤ `concurrency` (already ≤ HARD_CAPS.maxConcurrency),
 *   - lifetime          ≤ `durationSec` (already ≤ HARD_CAPS.maxDurationSec),
 *   - and it stops immediately on the kill switch.
 * Same governance as every other vector: allowlisted, authorized, capped.
 */

const TRICKLE_MS = 15_000; // one extra header line per connection, every 15 s
const MAX_CONNS = 500; // absolute ceiling (defense in depth; concurrency is already capped)

export async function runSlowloris(
  config: LoadTestConfig,
  allowedHosts: string[],
  killSignal?: AbortSignal,
  onProgress?: (p: LoadProgress) => void,
): Promise<LoadTestResult> {
  if (!config.authorized) {
    throw new InvalidConfigError(
      'The test must be explicitly authorized (authorized=true): confirm the target belongs to you.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new InvalidConfigError(`Invalid target URL: ${config.url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new InvalidConfigError(`Unsupported protocol ${parsed.protocol} (http/https only).`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new TargetNotAllowedError(
      `Target "${parsed.hostname}" is not in the ALLOWED_TARGETS allowlist.`,
    );
  }

  const secure = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  const path = parsed.pathname + parsed.search || '/';
  const connections = Math.min(Math.max(1, config.concurrency), MAX_CONNS);
  const durationMs = Math.max(1, config.durationSec) * 1000;
  const startedAt = new Date();
  const deadline = startedAt.getTime() + durationMs;

  let opened = 0;
  let shed = 0; // connections the server dropped/timed out (good defense)
  let peak = 0;
  const sockets = new Set<net.Socket | tls.TLSSocket>();
  const timers = new Set<NodeJS.Timeout>();
  let stopping = false;

  const partialRequest =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${parsed.hostname}\r\n` +
    `User-Agent: WEDOS-ShieldTest-slowloris\r\n` +
    `X-WEDOS-TEST: ${config.headers?.['X-WEDOS-TEST'] ?? randomUUID()}\r\n` +
    `Accept: */*\r\n`; // deliberately NOT terminated with the final CRLF

  const drop = (s: net.Socket | tls.TLSSocket) => {
    if (sockets.delete(s) && !stopping) shed++;
    s.destroy();
  };

  const openOne = () => {
    if (stopping) return;
    const onConnect = (s: net.Socket | tls.TLSSocket) => {
      opened++;
      sockets.add(s);
      peak = Math.max(peak, sockets.size);
      try {
        s.write(partialRequest);
      } catch {
        drop(s);
        return;
      }
      const t = setInterval(() => {
        if (stopping || s.destroyed) return;
        try {
          s.write(`X-a${Math.random().toString(36).slice(2, 8)}: keep-alive\r\n`);
        } catch {
          /* the drop handler will account for it */
        }
      }, TRICKLE_MS);
      timers.add(t);
      s.on('close', () => {
        clearInterval(t);
        timers.delete(t);
        drop(s);
      });
    };
    const s = secure
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname }, () =>
          onConnect(s),
        )
      : net.connect({ host: parsed.hostname, port }, () => onConnect(s));
    s.setTimeout(0);
    s.on('error', () => drop(s));
  };

  for (let i = 0; i < connections; i++) openOne();

  const tick = setInterval(() => {
    onProgress?.({
      sent: opened,
      successful: sockets.size, // currently held (the target let us hold them)
      failed: shed,
      elapsedSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      actualRps: 0,
    });
  }, 1000);

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (Date.now() >= deadline || killSignal?.aborted === true) {
        clearInterval(check);
        resolve();
      }
    }, 250);
  });

  stopping = true;
  clearInterval(tick);
  const heldAtEnd = sockets.size;
  for (const t of timers) clearInterval(t);
  for (const s of sockets) s.destroy();
  sockets.clear();

  const finishedAt = new Date();
  const durationSec = Math.max(1, (finishedAt.getTime() - startedAt.getTime()) / 1000);
  return {
    id: randomUUID(),
    config,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    // Mapped to the standard result: "requests" = connections opened; a
    // connection the server shed (timed out) counts as failed (good defense),
    // one still held at the end counts as successful (a resource we consumed).
    totalRequests: opened,
    successful: heldAtEnd,
    failed: shed,
    statusCounts: {},
    latencyMs: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 },
    actualRps: Number((opened / durationSec).toFixed(2)),
    errors: shed ? { 'shed-by-server': shed } : {},
  };
}
