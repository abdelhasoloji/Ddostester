import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card } from './helpers.js';

// RBAC coherence: what the UI offers must match what the role is allowed to do
// (catalog section K). No visible control should lead to a 403.

test('viewer cannot create campaigns (no New campaign button)', async ({ page }) => {
  await login(page, 'viewer');
  await goTo(page, 'Campaigns');
  await expect(page.getByRole('button', { name: /New campaign/ })).toHaveCount(0);
});

test('engineer can create but cannot approve (C1)', async ({ page }) => {
  await login(page, 'engineer');
  const name = await createCampaign(page, { name: `rbac-eng-${Date.now()}` });
  // The campaign is PENDING_APPROVAL, but the engineer role has no approve action.
  await expect(card(page, name)).toBeVisible();
  await expect(card(page, name).getByRole('button', { name: /Approve/ })).toHaveCount(0);
});

test('officer cannot approve their OWN campaign — separation of duties (C3)', async ({ page }) => {
  await login(page, 'officer');
  const name = await createCampaign(page, { name: `rbac-off-${Date.now()}` });
  // Officer has the approve action...
  await card(page, name).getByRole('button', { name: 'Approve / Reject' }).click();
  // ...but the modal blocks approving a campaign you authored.
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/separation of duties/i)).toBeVisible();
});
