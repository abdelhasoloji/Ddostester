import { isIP } from 'node:net';
import { INFRASTRUCTURE_LIMITS } from '../../config/limits.js';
import { digest } from '../drs/reference.js';

export const qualificationGates = [
  'architecture',
  'runtime',
  'nic',
  'management',
  'data-egress',
  'clock',
  'independent-probe',
  'stop-receipt',
] as const;
export type QualificationGate = (typeof qualificationGates)[number];
export interface HostProfile {
  siteId: string;
  name: string;
  architecture: 'arm64' | 'amd64' | null;
  os: string | null;
  runtime: string | null;
  cores: number | null;
  memoryGiB: number | null;
  nicModel: string | null;
  linkGbps: number | null;
  managementInterface: string | null;
  dataInterface: string | null;
  managementAddress: string | null;
  publicAddresses: string[];
  observedEgressAddresses: string[];
  notes: string;
}
export interface InfrastructureEvidence {
  hostId: string;
  profileHash: string;
  gate: QualificationGate;
  observedAt: string;
  outcome: 'pass' | 'fail' | 'unknown';
  content: string;
}
export interface InfrastructureRevision {
  kind: 'host' | 'evidence';
  id: string;
  revision: number;
  schemaVersion: 1;
  at: string;
  actor: string;
  previousHash: string | null;
  hash: string;
  payload: HostProfile | InfrastructureEvidence;
}
export class InfrastructureError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new InfrastructureError(message);
};
export const identifier = (value: unknown): string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
    ? value
    : fail('Invalid stable identifier');
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((k) => !keys.includes(k))) fail('Unknown infrastructure field');
  return data;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000'))
    fail('Invalid text');
  return (value as string).trim();
}
function nullable(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : text(value);
}
function positive(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e7)
    fail('Invalid hardware quantity');
  return value as number;
}
function addresses(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > INFRASTRUCTURE_LIMITS.maxAddresses)
    fail('Invalid address list');
  return [
    ...new Set(
      (value as unknown[]).map((v) => {
        const address = text(v, 64);
        if (!isIP(address)) fail('Expected an IPv4 or IPv6 address');
        return address;
      }),
    ),
  ];
}
export function hostProfile(value: unknown): HostProfile {
  const d = object(value, [
    'siteId',
    'name',
    'architecture',
    'os',
    'runtime',
    'cores',
    'memoryGiB',
    'nicModel',
    'linkGbps',
    'managementInterface',
    'dataInterface',
    'managementAddress',
    'publicAddresses',
    'observedEgressAddresses',
    'notes',
  ]);
  const name = text(d.name, 100);
  if (!name) fail('Host name required');
  const architecture = d.architecture ?? null;
  if (architecture !== null && architecture !== 'arm64' && architecture !== 'amd64')
    fail('Invalid architecture');
  const managementInterface = nullable(d.managementInterface),
    dataInterface = nullable(d.dataInterface);
  if (managementInterface && managementInterface === dataInterface)
    fail('Management and data interfaces must differ');
  const managementAddress = nullable(d.managementAddress);
  if (managementAddress && !isIP(managementAddress)) fail('Invalid management address');
  return {
    siteId: identifier(d.siteId),
    name,
    architecture: architecture as HostProfile['architecture'],
    os: nullable(d.os),
    runtime: nullable(d.runtime),
    cores: positive(d.cores),
    memoryGiB: positive(d.memoryGiB),
    nicModel: nullable(d.nicModel),
    linkGbps: positive(d.linkGbps),
    managementInterface,
    dataInterface,
    managementAddress,
    publicAddresses: addresses(d.publicAddresses),
    observedEgressAddresses: addresses(d.observedEgressAddresses),
    notes: text(d.notes ?? '', 2000),
  };
}
export function infrastructureEvidence(value: unknown, now = Date.now()): InfrastructureEvidence {
  const d = object(value, ['hostId', 'profileHash', 'gate', 'observedAt', 'outcome', 'content']);
  const hash = text(d.profileHash, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('Invalid profile hash');
  if (!qualificationGates.includes(d.gate as QualificationGate)) fail('Unknown qualification gate');
  if (!['pass', 'fail', 'unknown'].includes(String(d.outcome))) fail('Invalid evidence outcome');
  const observedAt = text(d.observedAt, 64),
    timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp) || timestamp > now + INFRASTRUCTURE_LIMITS.clockToleranceMs)
    fail('Invalid observation timestamp');
  const content = text(d.content, INFRASTRUCTURE_LIMITS.maxEvidenceChars);
  if (!content) fail('Evidence content required');
  return {
    hostId: identifier(d.hostId),
    profileHash: hash,
    gate: d.gate as QualificationGate,
    observedAt: new Date(timestamp).toISOString(),
    outcome: d.outcome as InfrastructureEvidence['outcome'],
    content,
  };
}
export function makeRevision(
  kind: InfrastructureRevision['kind'],
  id: string,
  payload: InfrastructureRevision['payload'],
  previous: InfrastructureRevision | undefined,
  actor: string,
): InfrastructureRevision {
  const record = {
    kind,
    id,
    revision: (previous?.revision ?? 0) + 1,
    schemaVersion: 1 as const,
    at: new Date().toISOString(),
    actor,
    previousHash: previous?.hash ?? null,
    payload,
  };
  return { ...record, hash: digest(record) };
}
export function qualification(
  hosts: InfrastructureRevision[],
  evidence: InfrastructureRevision[],
  selected: string[],
  now = Date.now(),
) {
  const selectedHosts = selected.map((id) => {
    const host = hosts.find((h) => h.id === id);
    const gates = qualificationGates.map((gate) => {
      const candidates = evidence.filter(
        (e) =>
          e.kind === 'evidence' &&
          (e.payload as InfrastructureEvidence).hostId === id &&
          (e.payload as InfrastructureEvidence).gate === gate,
      );
      const matching = candidates
        .filter((e) => (e.payload as InfrastructureEvidence).profileHash === host?.hash)
        .sort(
          (a, b) =>
            (b.payload as InfrastructureEvidence).observedAt.localeCompare(
              (a.payload as InfrastructureEvidence).observedAt,
            ) ||
            b.at.localeCompare(a.at) ||
            b.id.localeCompare(a.id),
        );
      const receipt = matching[0],
        payload = receipt?.payload as InfrastructureEvidence | undefined;
      const conflicting =
        !!payload &&
        matching.some(
          (e) =>
            (e.payload as InfrastructureEvidence).observedAt === payload.observedAt &&
            (e.payload as InfrastructureEvidence).outcome !== payload.outcome,
        );
      const status = conflicting
        ? 'conflicting'
        : !receipt
          ? candidates.length
            ? 'stale-profile'
            : 'missing'
          : now - Date.parse(payload!.observedAt) > INFRASTRUCTURE_LIMITS.evidenceMaxAgeMs
            ? 'expired'
            : payload!.outcome === 'pass'
              ? 'attested'
              : payload!.outcome;
      return { gate, status, evidenceId: receipt?.id ?? null, evidenceHash: receipt?.hash ?? null };
    });
    return {
      id,
      profileHash: host?.hash ?? null,
      gates,
      status: host && gates.every((g) => g.status === 'attested') ? 'documented' : 'incomplete',
    };
  });
  return {
    selectedHosts,
    status:
      selectedHosts.length === 2 && selectedHosts.every((h) => h.status === 'documented')
        ? 'documented'
        : 'incomplete',
    hardwareQualified: false,
    executionAuthorized: false,
    scope:
      'Operator evidence register. Attestations are not independently verified hardware qualification or DRS capacity.',
  };
}
