export interface LoadTestConfig {
  /** URL cible complète (ex: http://localhost:3000/health). */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Nombre de requêtes concurrentes (workers virtuels). */
  concurrency: number;
  /** Durée du test en secondes. */
  durationSec: number;
  /**
   * Plafond de requêtes/seconde (obligatoire) : garde-fou pour ne pas
   * saturer involontairement une infra. Doit être > 0.
   */
  maxRps: number;
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
