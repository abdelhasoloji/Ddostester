import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export interface DrsVector {
  internal_id: string;
  source_vector_id: string;
  source_section: string;
  source_page: number;
  level: number;
  family: string;
  name: string;
  required_properties: string[];
  load_requirements: Record<string, string>;
  service_requirements: Record<string, string>;
  source_text: string;
  interpretation_status: string;
  ambiguity_ids: string[];
}
export interface DrsAmbiguity {
  id: string;
  vector_id?: string;
  source_value: unknown;
  conflicting_value: unknown;
  selected_interpretation: unknown;
  rationale: string;
  review_status: string;
  affects_verdict: boolean;
}
export const DRS_ENGINE = 'shieldtester-drs/1';
export const DRS_INTERPRETATION = 'strict-conservative/1';
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const root = new URL('../../../../standards/drs/3.00.00/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const manifest = read('manifest.json') as {
  version: string;
  catalogue_sha256: string;
  source_url: string;
  publication_date: string;
  files: Record<string, string>;
  vector_count: number;
  license: string;
};
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256')
    .update(readFileSync(new URL(name, root)))
    .digest('hex');
  if (actual !== expected) throw Error('DRS immutable reference integrity failed: ' + name);
}
if (digest(manifest.files) !== manifest.catalogue_sha256)
  throw Error('DRS catalogue manifest integrity failed');
const catalogue = {
  manifest,
  vectors: read('vectors.json') as DrsVector[],
  types: read('types.json'),
  levels: read('levels.json'),
  ambiguities: read('ambiguities.json') as DrsAmbiguity[],
  scoring: read('scoring.json'),
};
export function drsReference() {
  return structuredClone(catalogue);
}
