/**
 * WRS — WEDOS Resiliency Score.
 * Fonction PURE de scoring de résilience (défensif) : elle NE génère aucun
 * trafic. Elle agrège des métriques mesurées pour produire un score 0-100.
 * Formule issue du TSD ShieldTest §5.4.
 */

export interface WrsInputs {
  /** Temps de détection de l'incident par la protection, en secondes. */
  detectionTimeSec: number;
  /** Temps de mitigation (retour à la normale), en secondes. */
  mitigationTimeSec: number;
  /** Requêtes légitimes servies avec succès pendant la campagne. */
  legitimateSuccessful: number;
  /** Requêtes légitimes totales émises par la sonde. */
  legitimateTotal: number;
  /**
   * Impact sur les services adjacents (0 = aucun, 100 = effondrement).
   * Mesuré par la sonde sur des endpoints voisins.
   */
  adjacentImpactScore: number;
}

export interface WrsBreakdown {
  detection: number; // D
  mitigation: number; // M
  availability: number; // A
  collateral: number; // C
  wrs: number;
  level: WrsLevel;
}

export type WrsLevel = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export function detectionScore(detectionTimeSec: number): number {
  return clamp(100 - detectionTimeSec / 2);
}

export function mitigationScore(mitigationTimeSec: number): number {
  return clamp(100 - mitigationTimeSec / 3);
}

export function availabilityScore(successful: number, total: number): number {
  if (total <= 0) return 0;
  return clamp((successful / total) * 100);
}

export function collateralScore(adjacentImpactScore: number): number {
  return clamp(100 - adjacentImpactScore);
}

export function wrsLevel(wrs: number): WrsLevel {
  if (wrs >= 95) return 'A+';
  if (wrs >= 85) return 'A';
  if (wrs >= 70) return 'B';
  if (wrs >= 50) return 'C';
  if (wrs >= 30) return 'D';
  return 'F';
}

export function computeWrs(inputs: WrsInputs): WrsBreakdown {
  const detection = detectionScore(inputs.detectionTimeSec);
  const mitigation = mitigationScore(inputs.mitigationTimeSec);
  const availability = availabilityScore(inputs.legitimateSuccessful, inputs.legitimateTotal);
  const collateral = collateralScore(inputs.adjacentImpactScore);

  const wrs = Number(
    (detection * 0.2 + mitigation * 0.3 + availability * 0.3 + collateral * 0.2).toFixed(2),
  );

  return {
    detection: Number(detection.toFixed(2)),
    mitigation: Number(mitigation.toFixed(2)),
    availability: Number(availability.toFixed(2)),
    collateral: Number(collateral.toFixed(2)),
    wrs,
    level: wrsLevel(wrs),
  };
}
