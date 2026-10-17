export interface InfrastructureHost {
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
export type InfrastructureGate =
  | 'architecture'
  | 'runtime'
  | 'nic'
  | 'management'
  | 'data-egress'
  | 'clock'
  | 'independent-probe'
  | 'stop-receipt';
export interface InfrastructureEvidenceInput {
  hostId: string;
  profileHash: string;
  gate: InfrastructureGate;
  observedAt: string;
  outcome: 'pass' | 'fail' | 'unknown';
  content: string;
}
export interface InfrastructureRecord<T> {
  kind: string;
  id: string;
  revision: number;
  schemaVersion: 1;
  at: string;
  actor: string;
  previousHash: string | null;
  hash: string;
  payload: T;
}
export interface PassivePrototypeCheckpoint {
  schema: string;
  observedOn: string;
  observationKind: 'dated-checkpoint';
  liveObservationAvailable: false;
  lastRecordedStatus: string;
  host: { name: string; managementAddress: string; architecture: string; virtualization: string };
  namespace: string;
  expectedPods: number;
  observedReadyPods: number | null;
  trafficGeneration: false;
  fleetEnrollment: false;
  resources: {
    requestCpuMillicores: number;
    requestMemoryMiB: number;
    limitCpuMillicores: number;
    limitMemoryMiB: number;
  };
  steps: { id: string; status: string; detail: string }[];
  artifact: { sha256: string; stagedPath: string };
  scope: string;
}
export interface InfrastructureWorkspace {
  passivePrototype?: PassivePrototypeCheckpoint;
  hosts: InfrastructureRecord<InfrastructureHost>[];
  evidence: InfrastructureRecord<InfrastructureEvidenceInput>[];
  qualification: {
    status: string;
    hardwareQualified: false;
    executionAuthorized: false;
    scope: string;
    selectedHosts: {
      id: string;
      profileHash: string | null;
      status: string;
      gates: {
        gate: InfrastructureGate;
        status: string;
        evidenceId: string | null;
        evidenceHash: string | null;
      }[];
    }[];
  };
  limits: { maxHosts: number; maxEvidence: number; maxRevisions: number; maxEvidenceChars: number };
  readiness: {
    standardVersion: string;
    catalogueHash: string;
    targetLevel: number;
    scope: string;
    fullPhysicalVectorsQualified: number;
    levels: { level: number; total: number; boundedHttp: number; physicalQualified: number }[];
    vectors: {
      id: string;
      name: string;
      level: number;
      family: string;
      sourceVectorId: string;
      sourcePage: number;
      adapter: string;
      fullPhysicalStatus: string;
      ambiguityCount: number;
    }[];
  };
}
