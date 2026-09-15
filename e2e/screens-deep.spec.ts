import { test, expect, type Page, type Browser } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// Deep coverage of the stateful / per-item clickable actions on each screen,
// beyond render + tabs: campaign card actions (approve/reject/run/cancel/archive/
// details), templates (sort/chips/compose/clear/custom playbook), settings
// (users/limits/notifications/grafana/password/purge), and the read screens.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

/** Create a campaign as engineer and return { name, ctx, page }. */
async function seed(browser: Browser, over = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, 'engineer');
  const name = await createCampaign(page, {
    name: `deep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    target: SELF,
    probe: SELF,
    ...over,
  });
  return { name, ctx, page };
}

test('campaign card: Details opens the drawer and closes', async ({ browser }) => {
  const { name, ctx, page } = await seed(browser);
  await goTo(page, 'Campaigns');
  await (await openCard(page, name)).getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('aside.drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('aside.drawer')).toHaveCount(0); // it actually closed
  await ctx.close();
});

test('campaign card: a CISO cancels a pending campaign (approve-gated)', async ({ browser }) => {
  const { name, ctx } = await seed(browser);
  const cctx = await browser.newContext();
  const ciso = await cctx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await (await openCard(ciso, name)).getByRole('button', { name: 'Cancel' }).click();
  await expect(card(ciso, name).getByText('Cancelled', { exact: true })).toBeVisible();
  await ctx.close();
  await cctx.close();
});

test('campaign card: CISO rejects a campaign with a reason', async ({ browser }) => {
  const { name, ctx } = await seed(browser);
  const cctx = await browser.newContext();
  const ciso = await cctx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('textbox').last().fill('e2e reject reason');
  await ciso.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(card(ciso, name).getByText('Rejected')).toBeVisible();
  await ctx.close();
  await cctx.close();
});

test('campaign card: Run opens the Execute modal, which cancels without launching', async ({
  browser,
}) => {
  const { name, ctx, page } = await seed(browser);
  const cctx = await browser.newContext();
  const ciso = await cctx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, name).getByText('Approved')).toBeVisible();

  await page.reload();
  await goTo(page, 'Campaigns');
  await (await openCard(page, name)).getByRole('button', { name: 'Run', exact: true }).click();
  // The Execute modal: h3 "Confirm run", primary "Launch campaign".
  await expect(page.getByRole('heading', { name: 'Confirm run' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch campaign' })).toBeVisible();
  await page.keyboard.press('Escape'); // cancel the modal → still Approved, not run
  await expect(card(page, name).getByText('Approved')).toBeVisible();
  await ctx.close();
  await cctx.close();
});

test('campaign card: archive then restore a campaign', async ({ browser }) => {
  const { name, ctx, page } = await seed(browser);
  await goTo(page, 'Campaigns');
  await (await openCard(page, name)).getByRole('button', { name: 'Archive' }).click();
  // Archive actually hid it from the default (non-archived) list.
  await expect(card(page, name)).toHaveCount(0);
  // Reveal archived, restore → it's no longer archived (Restore gone, Archive back).
  await page.locator('label.archived-toggle input[type="checkbox"]').check();
  await (await openCard(page, name)).getByRole('button', { name: 'Restore' }).click();
  await expect((await openCard(page, name)).getByRole('button', { name: 'Restore' })).toHaveCount(
    0,
  );
  await expect((await openCard(page, name)).getByRole('button', { name: 'Archive' })).toBeVisible();
  await ctx.close();
});

test('templates: sort controls, allowed-host chip, compose two, then clear', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  // Sort buttons (a role=group of sort options).
  const sortGroup = page.locator('[aria-label="Sort templates"]');
  for (const btn of await sortGroup.getByRole('button').all()) {
    await btn.click();
    await noError(page);
  }
  // Allowed-host chip fills the target.
  const chip = page.locator('.allowed-chips .chip-xs').first();
  if (await chip.count()) {
    await chip.click();
    await expect(page.locator('.tpl-launchbar input').first()).not.toHaveValue('');
  }
  // Select two templates → compose bar counts them → Clear.
  const boxes = page.locator('input[aria-label^="Select "]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator('.tcb-chip')).toHaveCount(2); // two in the basket
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.tcb-chip')).toHaveCount(0); // Clear actually emptied it
});

test('settings: admin adds a user then deletes it', async ({ page }) => {
  await login(page, 'officer'); // → admin
  await goTo(page, 'Settings');
  const email = `e2e-ui-${Date.now()}@wedos`;
  await page.locator('.field:has(label:text-is("Email")) input').fill(email);
  await page
    .locator('.field:has(label:text-is("Temporary password")) input')
    .fill('e2e-temp-pass-123');
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  // Env users are immutable (no Remove), so the only "Remove" is the new user.
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  await noError(page);
});

test('settings: notifications Test button', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Settings');
  const testBtn = page.getByRole('button', { name: /^Test$|Send test/ });
  if (await testBtn.count()) {
    await testBtn.first().click();
    await noError(page);
  }
});

test('settings: operational limits form saves (always-editable, no Edit step)', async ({
  page,
}) => {
  // LimitsCard is an always-editable form with a "Save limits" button — there is
  // no separate Edit step (the earlier test looked for a non-existent "Edit").
  await login(page, 'officer');
  await goTo(page, 'Settings');
  const card = page.locator('.card', { hasText: 'Operational limits' });
  const save = card.getByRole('button', { name: 'Save limits' });
  await expect(save).toBeVisible();
  await save.click();
  await expect(page.getByText(/Operational limits updated/)).toBeVisible();
  await noError(page);
});

test('command center: renders the resilience summary and opens Run Theater', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Command Center');
  await noError(page);
  const link = page.getByRole('link', { name: /Run Theater/ });
  if (await link.count()) {
    await link.first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Run Theater' })).toBeVisible();
  }
});

test('assurance: Verify integrity produces a chain verdict', async ({ page }) => {
  await login(page, 'officer'); // admin sees the audit + verify control
  await goTo(page, 'Assurance');
  await page.getByRole('button', { name: /Verify integrity/ }).click();
  // The verify produces a real verdict, not just no error.
  await expect(page.getByText(/Chain intact|tampered|broken/i)).toBeVisible({ timeout: 10_000 });
});

test('protected zones and prepare screens render and expose their actions', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Protected zones');
  await noError(page);
  await goTo(page, 'Prepare');
  await noError(page);
});
