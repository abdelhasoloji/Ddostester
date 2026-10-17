import { FLEET_LIMITS, FLEET_INVENTORY_LIMITS } from '../../config/limits.js';
import { syntheticApproximation } from './synthetic-catalog.js';
import { drsReference } from './reference.js';
export const drsWorkflow = () => process.env.CAMPAIGN_CATALOG === 'drs-fleet';
export const DRS_CATALOG_VERSION = '3.00.00';
export function drsCatalog() {
  const { manifest, vectors } = drsReference();
  return {
    version: manifest.version,
    reference: 'DRS 3.00.00 · 4 August 2026',
    catalogueHash: manifest.catalogue_sha256,
    sourceUrl: manifest.source_url,
    provenance:
      'Official PDF archived with per-line source pages, original values and unresolved ambiguities',
    scope:
      'Reference catalogue; bounded laboratory profiles are not full standard exposures or certification',
    executionCaps: FLEET_LIMITS,
    inventoryCaps: FLEET_INVENTORY_LIMITS,
    profiles: vectors.map((v) => {
      const supported = v.source_vector_id.endsWith('51002');
      return {
        id: v.internal_id,
        name: v.name,
        level: v.level,
        summary:
          'Source ' +
          v.source_vector_id +
          ' · section ' +
          v.source_section +
          ' · page ' +
          v.source_page,
        sourceVectorId: v.source_vector_id,
        sourcePage: v.source_page,
        ambiguityCount: v.ambiguity_ids.length,
        supported,
        laboratory: syntheticApproximation(v.source_type_id ?? ''),
        status: supported ? 'bounded-get-experiment' : 'reference-only',
        reason: supported
          ? 'Bounded GET laboratory approximation only. Full DRS load, source diversity, persistence and combined exposure are not established.'
          : 'Reference and engine simulation only. No generator adapter or traffic dispatch; no local fallback.',
      };
    }),
  };
}
