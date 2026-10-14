import { randomBytes } from 'node:crypto';
import { readBoundedBody } from '../../util/http-body.js';
import { validateProbeQuality, type ProbeQuality } from './quality.js';
import type { RemoteProbeConfig } from '../../config/limits.js';

export function probeChallenge() {
  return {
    schema: 'ddostester.probe.request/v2',
    requestId: randomBytes(16).toString('hex'),
    sentAt: Date.now(),
  };
}
export function validateProbeFreshness(
  value: unknown,
  challenge: { requestId: string; sentAt: number },
  receivedAt = Date.now(),
): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid remote probe freshness');
  const response = value as Record<string, unknown>;
  const observedAt =
    typeof response.observedAt === 'string' ? Date.parse(response.observedAt) : NaN;
  if (
    response.schema !== 'ddostester.probe.response/v2' ||
    response.requestId !== challenge.requestId ||
    typeof response.observedAt !== 'string' ||
    response.observedAt.length !== 24 ||
    !Number.isFinite(observedAt) ||
    receivedAt < challenge.sentAt ||
    observedAt < challenge.sentAt - 2000 ||
    observedAt > receivedAt + 2000
  )
    throw new Error('Invalid remote probe freshness');
  const quality = response.quality as Record<string, unknown> | undefined;
  if (quality) {
    const sampledAt = typeof quality.sampledAt === 'string' ? Date.parse(quality.sampledAt) : NaN;
    if (
      !Number.isFinite(sampledAt) ||
      sampledAt < challenge.sentAt - 2000 ||
      sampledAt > observedAt + 2000
    )
      throw new Error('Invalid remote probe diagnostic freshness');
  }
}

/** Shared baseline/recovery transport; never silently substitutes a local sample. */
export async function sampleRemoteProbe(
  remote: RemoteProbeConfig,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; latencyMs: number; quality?: ProbeQuality }> {
  const endpoint = new URL(remote.agentUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error('Invalid configured probe endpoint');
  const challenge = probeChallenge();
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${remote.token}` },
    body: JSON.stringify({
      url,
      timeoutMs,
      schema: challenge.schema,
      requestId: challenge.requestId,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error('Remote probe unavailable');
  }
  const value: unknown = JSON.parse(
    new TextDecoder().decode(await readBoundedBody(res.body, 65536)),
  );
  validateProbeFreshness(value, challenge);
  return validateRemoteSample(value, timeoutMs);
}
export function validateRemoteSample(
  value: unknown,
  timeoutMs: number,
): { ok: boolean; status: number; latencyMs: number; quality?: ProbeQuality } {
  if (!value || typeof value !== 'object') throw new Error('Invalid remote probe sample');
  const x = value as Record<string, unknown>;
  if (
    typeof x.ok !== 'boolean' ||
    x.ok !== ((x.status as number) >= 200 && (x.status as number) < 300) ||
    !Number.isInteger(x.status) ||
    (x.status as number) < 0 ||
    (x.status as number) > 599 ||
    typeof x.latencyMs !== 'number' ||
    !Number.isFinite(x.latencyMs) ||
    x.latencyMs < 0 ||
    x.latencyMs > timeoutMs + 1000
  )
    throw new Error('Invalid remote probe sample');
  const quality = validateProbeQuality(x.quality);
  return {
    ok: x.ok,
    status: x.status as number,
    latencyMs: x.latencyMs,
    ...(quality ? { quality } : {}),
  };
}
