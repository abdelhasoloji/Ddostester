/** Phase d'un scénario borné : un débit maintenu pendant une durée. */
export interface ScenarioPhase {
  maxRps: number;
  durationSec: number;
}

export interface LoadTestConfig {
  /** URL cible complète (ex: http://localhost:3000/health). */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Nombre de requêtes concurrentes (workers virtuels). */
  concurrency: number;
  /** Durée du test en secondes (phase unique ; ignorée si `phases` est fourni). */
  durationSec: number;
  /**
   * Plafond de requêtes/seconde (obligatoire) : garde-fou pour ne pas
   * saturer involontairement une infra. Doit être > 0. En multi-phases,
   * représente le débit maximal parmi les phases.
   */
  maxRps: number;
  /**
   * Scénario borné optionnel (GEN-03) : phases séquentielles (ramp-up, vagues…).
   * Chaque phase reste soumise aux mêmes plafonds. Absent = phase unique.
   */
  phases?: ScenarioPhase[];
  /**
   * Accusé de responsabilité : l'utilisateur confirme que la cible lui
   * appartient ou qu'il dispose d'une autorisation écrite. Sans ce flag,
   * le test est refusé.
   */
  authorized: boolean;
  timeoutMs?: number;
}

export interface LoadTestResult {
  id: string;
  config: LoadTestConfig;
  startedAt: string;
  finishedAt: string;
  totalRequests: number;
  successful: number;
  failed: number;
  statusCounts: Record<string, number>;
  latencyMs: { min: number; max: number; mean: number; p50: number; p95: number; p99: number };
  actualRps: number;
  errors: Record<string, number>;
}
