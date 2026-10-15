export interface ClientProfile {
  name: string;
  environment: 'unspecified' | 'preproduction' | 'lab';
  reference: string;
  owner: string;
  scope: string;
  notes: string;
}
export interface ClientWorkspace {
  id: string;
  revision: number;
  hash: string | null;
  profile: ClientProfile;
  status: 'authorized';
  authorization: 'client-authorized-target-scope-separate';
  measuredScore: null;
}
export interface ClientWorkspaceList {
  targetLevel: number;
  pilot: { sites: number; independentProbe: number; capacityQualified: false };
  clients: ClientWorkspace[];
}
