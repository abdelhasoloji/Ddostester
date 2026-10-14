export interface FleetDeviceInput {
  siteId?: string;
  agentId: string;
  name: string;
  group: string;
  profile: 'sensor' | 'camera' | 'gateway' | 'generic';
  privateIp: string;
  notes: string;
}
export interface FleetDevice extends FleetDeviceInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  credential?: { hash: string; expiresAt: number };
  heartbeat?: {
    sequence: number;
    receivedAt: number;
    version: string;
    uptimeSec: number;
    peerIp: string;
  };
  enrollmentRevoked?: boolean;
}
export function fleetDeviceView(device: FleetDevice, now = Date.now()) {
  const connection = device.enrollmentRevoked
    ? 'revoked'
    : !device.credential
      ? 'unenrolled'
      : device.credential.expiresAt <= now
        ? 'expired'
        : !device.heartbeat
          ? 'awaiting'
          : now - device.heartbeat.receivedAt > 30_000
            ? 'offline'
            : 'online';
  return {
    id: device.id,
    siteId: device.siteId ?? 'vps-lab',
    agentId: device.agentId,
    name: device.name,
    group: device.group,
    profile: device.profile,
    privateIp: device.privateIp,
    notes: device.notes,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    connection,
    enrollmentExpiresAt: device.credential
      ? new Date(device.credential.expiresAt).toISOString()
      : null,
    lastSeenAt: device.heartbeat ? new Date(device.heartbeat.receivedAt).toISOString() : null,
    agentVersion: device.heartbeat?.version ?? null,
  };
}
export class DeviceInputError extends Error {}
export const deviceInput = {
  parse(body: unknown): FleetDeviceInput {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DeviceInputError('Invalid device');
    const data = body as Record<string, unknown>;
    const keys = ['agentId', 'name', 'group', 'profile', 'privateIp', 'notes', 'siteId'];
    if (Object.keys(data).some((key) => !keys.includes(key)))
      throw new DeviceInputError('Unknown device field');
    const text = (key: string, max: number, optional = false) => {
      const value = data[key] ?? (optional ? '' : undefined);
      if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim()))
        throw new DeviceInputError(`Invalid ${key}`);
      return value.trim();
    };
    const siteId = text('siteId', 64, true);
    if (siteId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(siteId))
      throw new DeviceInputError('Invalid site ID');
    const agentId = text('agentId', 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(agentId))
      throw new DeviceInputError('Invalid agent ID');
    const privateIp = text('privateIp', 15);
    const parts = privateIp.split('.');
    const [a, b] = parts.map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) ||
      !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    )
      throw new DeviceInputError('Use a private RFC1918 IPv4 address');
    const profile = text('profile', 16);
    if (!['sensor', 'camera', 'gateway', 'generic'].includes(profile))
      throw new DeviceInputError('Invalid device profile');
    return {
      ...(siteId ? { siteId } : {}),
      agentId,
      privateIp,
      profile: profile as FleetDeviceInput['profile'],
      name: text('name', 100),
      group: text('group', 64),
      notes: text('notes', 1000, true),
    };
  },
};
