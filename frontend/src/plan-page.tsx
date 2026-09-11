import { PageHead, GapPlannerSection } from './pages.js';

/**
 * Plan phase (2/5) — scanning/enumeration analogue: turn the declared or
 * recon-seeded defenses into a prioritised bounded replay plan (the DRS ladder,
 * weakest link, break point). See docs/five-phase-model.md.
 */
export function PlanPage({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <>
      {!embedded && (
        <PageHead
          title="Plan"
          sub="Map the target's defenses to a prioritised, bounded replay plan — the DRS escalation ladder, the weakest link per line, and the predicted break point. Seeded from recon, or declared by hand."
        />
      )}
      <GapPlannerSection />
    </>
  );
}
