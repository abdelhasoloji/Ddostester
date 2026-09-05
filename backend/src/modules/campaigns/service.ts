import { randomUUID } from 'node:crypto';
import { HARD_CAPS } from './model.js';
import type { Campaign, CampaignInput, CampaignStatus } from './model.js';

export class CampaignError extends Error {}

function assertHostAllowed(rawUrl: string, allowedHosts: string[], label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CampaignError(`${label} : URL invalide (${rawUrl}).`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CampaignError(`${label} : seuls http/https sont supportés.`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new CampaignError(
      `${label} : hôte « ${parsed.hostname} » hors liste blanche. ` +
        `Seules les cibles pré-validées (internes / mandatées) sont acceptées.`,
    );
  }
}

/**
 * Valide et crée une campagne au statut PENDING_APPROVAL. Applique les
 * garde-fous : autorisation attestée, cible et sonde dans la liste blanche,
 * intensité/durée bornées par HARD_CAPS.
 */
export function createCampaign(input: CampaignInput, allowedHosts: string[]): Campaign {
  if (!input.authorized) {
    throw new CampaignError(
      "La campagne doit être attestée autorisée (authorized=true) par l'auteur.",
    );
  }
  if (!input.name?.trim()) throw new CampaignError('Nom de campagne requis.');
  if (!input.createdBy?.trim()) throw new CampaignError('Auteur (createdBy) requis.');

  assertHostAllowed(input.target, allowedHosts, 'Cible');
  assertHostAllowed(input.probeUrl, allowedHosts, 'Sonde');

  if (!(input.maxRps > 0) || input.maxRps > HARD_CAPS.maxRps) {
    throw new CampaignError(`maxRps doit être dans ]0, ${HARD_CAPS.maxRps}].`);
  }
  if (input.concurrency < 1 || input.concurrency > HARD_CAPS.maxConcurrency) {
    throw new CampaignError(`concurrency doit être dans [1, ${HARD_CAPS.maxConcurrency}].`);
  }
  if (input.maxDurationSec < 1 || input.maxDurationSec > HARD_CAPS.maxDurationSec) {
    throw new CampaignError(`maxDurationSec doit être dans [1, ${HARD_CAPS.maxDurationSec}].`);
  }

  if (input.scheduledAt !== undefined && Number.isNaN(Date.parse(input.scheduledAt))) {
    throw new CampaignError('scheduledAt : date ISO invalide.');
  }

  if (input.scenario) {
    if (input.scenario.length < 1 || input.scenario.length > 12) {
      throw new CampaignError('Un scénario doit comporter entre 1 et 12 phases.');
    }
    let totalDur = 0;
    for (const p of input.scenario) {
      if (!(p.maxRps > 0) || p.maxRps > HARD_CAPS.maxRps) {
        throw new CampaignError(`Phase : maxRps doit être dans ]0, ${HARD_CAPS.maxRps}].`);
      }
      if (p.durationSec < 1) throw new CampaignError('Phase : durée ≥ 1 s.');
      totalDur += p.durationSec;
    }
    if (totalDur > HARD_CAPS.maxDurationSec) {
      throw new CampaignError(`Durée totale du scénario ≤ ${HARD_CAPS.maxDurationSec}s.`);
    }
    // Normalise les champs agrégés pour l'affichage/metrics.
    input.maxRps = Math.max(...input.scenario.map((p) => p.maxRps));
    input.maxDurationSec = totalDur;
  }

  return {
    ...input,
    id: randomUUID(),
    status: 'PENDING_APPROVAL',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Workflow d'approbation (TSD §5.1 CAM-02) : le Security Officer approuve ou
 * rejette. L'approbation est valable 24h. Séparation des rôles : l'approbateur
 * doit être différent de l'auteur.
 */
export function approveCampaign(
  campaign: Campaign,
  approvedBy: string,
  decision: 'APPROVED' | 'REJECTED',
  reason?: string,
): Campaign {
  if (campaign.status !== 'PENDING_APPROVAL') {
    throw new CampaignError(`Campagne non approuvable (statut ${campaign.status}).`);
  }
  if (!approvedBy?.trim()) throw new CampaignError('Approbateur requis.');
  if (approvedBy === campaign.createdBy) {
    throw new CampaignError('Séparation des rôles : approbateur ≠ auteur.');
  }
  if (decision === 'REJECTED' && !reason?.trim()) {
    throw new CampaignError('Un rejet doit être motivé.');
  }

  const approvalExpiresAt =
    decision === 'APPROVED' ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined;

  return { ...campaign, status: decision, approvedBy, approvalReason: reason, approvalExpiresAt };
}

/** Vérifie qu'une campagne est exécutable maintenant (approuvée, non expirée). */
export function assertExecutable(campaign: Campaign): void {
  if (campaign.status !== 'APPROVED') {
    throw new CampaignError(`Campagne non exécutable (statut ${campaign.status}).`);
  }
  if (campaign.approvalExpiresAt && Date.parse(campaign.approvalExpiresAt) < Date.now()) {
    throw new CampaignError("L'approbation a expiré (validité 24h) — à re-soumettre.");
  }
}

export function transition(campaign: Campaign, status: CampaignStatus): Campaign {
  return { ...campaign, status };
}
