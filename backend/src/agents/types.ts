import type { LoadTestConfig, LoadTestResult } from '../engine/types.js';
import type { LoadProgress } from '../engine/loadTest.js';

/**
 * Contrat d'agent de charge (« bring-your-own-generator »). ShieldTest reste le
 * plan de contrôle (autorisation, allowlist, plafonds, kill switch, sonde, WRS,
 * audit) ; l'agent se contente de produire la charge et de rapporter des
 * métriques. Un agent DOIT respecter la config bornée (validateConfig) et le
 * signal d'arrêt. Aucun agent fourni ici n'implémente de vecteur d'attaque :
 * le générateur intégré est du HTTP borné ; l'adaptateur k6 délègue à un outil
 * de test de charge externe, licencié et opéré par l'équipe.
 */

/** Erreur opérationnelle d'agent (ex. outil externe indisponible) → 503. */
export class AgentError extends Error {}

export interface AttackAgent {
  readonly name: string;
  /** Indique si l'agent est utilisable dans l'environnement courant. */
  available(): Promise<boolean>;
  run(
    config: LoadTestConfig,
    allowedHosts: string[],
    killSignal?: AbortSignal,
    onProgress?: (p: LoadProgress) => void,
  ): Promise<LoadTestResult>;
}
