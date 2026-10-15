import { InfrastructureError } from './model.js';
export interface ClientProfile {
  name: string;
  environment: 'unspecified' | 'preproduction' | 'lab';
  reference: string;
  owner: string;
  scope: string;
  notes: string;
}
export const initialClients: { id: string; profile: ClientProfile }[] = [
  {
    id: 'bank-cz',
    profile: {
      name: 'bank.cz',
      environment: 'unspecified',
      reference: 'bank.cz',
      owner: '',
      scope: '',
      notes: '',
    },
  },
  {
    id: 'enisa-preprod',
    profile: {
      name: 'ENISA preproduction',
      environment: 'preproduction',
      reference: '',
      owner: '',
      scope: '',
      notes: '',
    },
  },
  {
    id: 'test-vps',
    profile: {
      name: 'Test VPS',
      environment: 'lab',
      reference: '46.28.109.92',
      owner: '',
      scope: '',
      notes: 'Historical test address; confirm the current scope and address.',
    },
  },
];
export function clientProfile(value: unknown): ClientProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InfrastructureError('Invalid client profile');
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).some(
      (k) => !['name', 'environment', 'reference', 'owner', 'scope', 'notes'].includes(k),
    )
  )
    throw new InfrastructureError('Unknown client field');
  const text = (key: string, max: number) => {
    const value = d[key] ?? '';
    if (typeof value !== 'string' || value.length > max || value.includes('\u0000'))
      throw new InfrastructureError('Invalid ' + key);
    return value.trim();
  };
  const name = text('name', 100),
    environment = text('environment', 24);
  if (!name || !['unspecified', 'preproduction', 'lab'].includes(environment))
    throw new InfrastructureError('Client name and valid environment required');
  return {
    name,
    environment: environment as ClientProfile['environment'],
    reference: text('reference', 256),
    owner: text('owner', 256),
    scope: text('scope', 2000),
    notes: text('notes', 2000),
  };
}
