/** Entrée du journal d'audit (traçabilité des actions — TSD §5.5 / gouvernance). */
export interface AuditEntry {
  id: string;
  at: string; // ISO
  actor: string; // email authentifié, ou 'dev' si auth désactivée
  action:
    | 'campaign.create'
    | 'campaign.approve'
    | 'campaign.reject'
    | 'campaign.execute'
    | 'campaign.kill';
  campaignId?: string;
  detail?: string;
}
