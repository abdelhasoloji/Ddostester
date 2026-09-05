import type { WrsBreakdown } from '../wrs/scoring.js';

/**
 * Seul vecteur de charge supporté par ce control plane : requêtes HTTP
 * applicatives bornées (GET/POST) vers une cible autorisée. Les vecteurs
 * volumétriques L3/L4 (floods, amplification) et d'épuisement L7 (Slowloris,
 * RUDY, XML bomb…) du TSD §5.2 ne sont PAS implémentés — voir README.
 */
export type LoadVector = 'http-get' | 'http-post';

export type CampaignStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'KILLED_AUTO'
  | 'KILLED_MANUAL';

export interface CampaignInput {
  name: string;
  description?: string;
  /** URL cible (doit appartenir à la liste blanche). */
  target: string;
  vector: LoadVector;
  body?: string;
  headers?: Record<string, string>;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  /** Endpoint sondé pour mesurer l'impact (souvent la cible elle-même). */
  probeUrl: string;
  createdBy: string;
  /** L'auteur atteste que la cible est autorisée (interne WEDOS / mandat écrit). */
  authorized: boolean;
  /**
   * Fenêtre d'exécution planifiée (ISO). Si définie, la campagne, une fois
   * APPROVED, est exécutée automatiquement par l'ordonnanceur à cette heure
   * (CAM-01). Absent = exécution manuelle.
   */
  scheduledAt?: string;
}

export interface Campaign extends CampaignInput {
  id: string;
  status: CampaignStatus;
  createdAt: string;
  approvedBy?: string;
  approvalReason?: string;
  approvalExpiresAt?: string;
  wrs?: WrsBreakdown;
  runId?: string;
}

/** Plafonds durs, non contournables par l'API (défense en profondeur). */
export const HARD_CAPS = {
  maxRps: 2000,
  maxConcurrency: 500,
  maxDurationSec: 900, // timeout temporel absolu (15 min, TSD §5.1)
} as const;
