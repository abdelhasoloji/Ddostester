import { describe, it, expect } from 'vitest';
import {
  createCampaign,
  approveCampaign,
  assertExecutable,
  CampaignError,
} from '../src/modules/campaigns/service.js';
import type { CampaignInput } from '../src/modules/campaigns/model.js';

const allowed = ['localhost'];
const base: CampaignInput = {
  name: 'Test résilience',
  target: 'http://localhost:3000/',
  vector: 'http-get',
  maxRps: 100,
  concurrency: 10,
  maxDurationSec: 60,
  probeUrl: 'http://localhost:3000/health',
  createdBy: 'engineer@wedos',
  authorized: true,
};

describe('CAM workflow', () => {
  it('crée une campagne PENDING_APPROVAL', () => {
    const c = createCampaign(base, allowed);
    expect(c.status).toBe('PENDING_APPROVAL');
  });

  it('refuse une cible hors liste blanche', () => {
    expect(() => createCampaign({ ...base, target: 'http://victim.example/' }, allowed)).toThrow(
      CampaignError,
    );
  });

  it('refuse sans attestation d’autorisation', () => {
    expect(() => createCampaign({ ...base, authorized: false }, allowed)).toThrow(CampaignError);
  });

  it('plafonne l’intensité (HARD_CAPS)', () => {
    expect(() => createCampaign({ ...base, maxRps: 999_999 }, allowed)).toThrow(CampaignError);
  });

  it('impose la séparation des rôles à l’approbation', () => {
    const c = createCampaign(base, allowed);
    expect(() => approveCampaign(c, base.createdBy, 'APPROVED')).toThrow(CampaignError);
  });

  it('approuve et rend exécutable', () => {
    const c = approveCampaign(createCampaign(base, allowed), 'officer@wedos', 'APPROVED');
    expect(c.status).toBe('APPROVED');
    expect(() => assertExecutable(c)).not.toThrow();
  });

  it('exige un motif pour un rejet', () => {
    const c = createCampaign(base, allowed);
    expect(() => approveCampaign(c, 'officer@wedos', 'REJECTED')).toThrow(CampaignError);
  });
});
