import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard } from './helpers.js';

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
  await expect((await openCard(page, name)).getByRole('button', { name: /Approve/ })).toHaveCount(
    0,
  );
});

test('an admin (officer) has no create action — separation of administration (C2)', async ({
  page,
}) => {
  await login(page, 'officer'); // officer → admin: manages users/limits, not campaigns
  await goTo(page, 'Campaigns');
  await expect(page.getByRole('button', { name: /New campaign/ })).toHaveCount(0);
});

test('a CISO approves an engineer-authored campaign — author ≠ approver (C3)', async ({
  browser,
}) => {
  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  const name = await createCampaign(eng, { name: `rbac-sod-${Date.now()}` });

  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
  const approve = ciso.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeEnabled(); // different author → approval allowed
  await approve.click();
  await expect(card(ciso, name).getByText('Approved')).toBeVisible();
  await engCtx.close();
  await cisoCtx.close();
});
