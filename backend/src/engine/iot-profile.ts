import { createHash } from 'node:crypto';
import type { RequestStep } from './types.js';

export interface IoTProfile {
  id: 'sensor-heartbeat/v1';
  /** Public reproducibility input, never a credential. */
  seed: number;
  deviceIndex: number;
}

/** Fixed synthetic journey: health GET, then a small telemetry POST.
 * No wall clock or random state affects its identity, payload or think-time.
 * It models HTTP application behaviour only, not firmware or a network location.
 */
export function compileIoTProfile(
  profile: IoTProfile,
  target: string,
  probe: string,
): RequestStep[] {
  if (!profile || profile.id !== 'sensor-heartbeat/v1') throw new Error('Unknown IoT profile');
  if (!Number.isSafeInteger(profile.seed) || profile.seed < 0 || profile.seed > 0xffffffff)
    throw new Error('IoT seed must be an unsigned 32-bit integer');
  if (
    !Number.isSafeInteger(profile.deviceIndex) ||
    profile.deviceIndex < 0 ||
    profile.deviceIndex > 999
  )
    throw new Error('IoT deviceIndex must be within [0, 999]');
  const telemetry = new URL(target);
  const health = new URL(probe);
  if (telemetry.origin !== health.origin)
    throw new Error('IoT health and telemetry must share an origin');
  const digest = createHash('sha256')
    .update(`${profile.id}:${profile.seed}:${profile.deviceIndex}`, 'utf8')
    .digest();
  const body = JSON.stringify({
    schema: 'ddostester.synthetic-sensor/v1',
    deviceId: `sim-${digest.subarray(0, 12).toString('hex')}`,
    sequence: 0,
    temperatureCentiC: 1500 + (digest.readUInt16BE(12) % 1501),
    batteryPercent: 20 + (digest[14] % 81),
  });
  return [
    {
      name: 'iot-health',
      method: 'GET',
      url: probe,
      thinkMs: 500 + (digest.readUInt16BE(15) % 1001),
    },
    {
      name: 'iot-telemetry',
      method: 'POST',
      url: target,
      body,
      headers: { 'content-type': 'application/json' },
      thinkMs: 1000 + (digest.readUInt16BE(17) % 1001),
    },
  ];
}
