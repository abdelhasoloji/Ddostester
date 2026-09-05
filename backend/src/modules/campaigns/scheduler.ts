import type { Campaign } from './model.js';

/**
 * Sélectionne les campagnes à exécuter maintenant (CAM-01) : approuvées, avec
 * une fenêtre planifiée échue, dont l'approbation n'a pas expiré. Fonction pure
 * (testable) ; l'orchestration (timer) est dans le serveur.
 */
export function dueCampaigns(campaigns: Campaign[], nowMs: number): Campaign[] {
  return campaigns.filter((c) => {
    if (c.status !== 'APPROVED' || !c.scheduledAt) return false;
    const at = Date.parse(c.scheduledAt);
    if (Number.isNaN(at) || at > nowMs) return false;
    if (c.approvalExpiresAt && Date.parse(c.approvalExpiresAt) < nowMs) return false;
    return true;
  });
}
