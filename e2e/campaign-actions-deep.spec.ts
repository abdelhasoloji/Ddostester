import { test, expect, type Page, type Browser } from '@playwright/test';
import { login, goTo, createCampaign, card, SELF } from './helpers.js';

// Stateful campaign-card / drawer actions the other specs don't reach: the live
// Kill switch on a RUNNING campaign (now enabled during a run — the kill guard was
// moved off `busy`), approving from inside the details drawer (the modal now layers
// above the drawer — z-index fix), the list sort select, and suite compose.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

/** Engineer creates a campaign; returns its name + the engineer page/context. */
async function seed(browser: Browser, over = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, 'engineer');
  const name = await createCampaign(page, {
    name: `act-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    target: SELF,
    probe: SELF,
    ...over,
  });
  return { name, ctx, page };
}

test('kill switch: engineer kills their own RUNNING campaign from the live drawer', async ({
  browser,
}) => {
  // Regression guard for the kill-during-run fix: `execute()` blocks the page and
  // holds `busy`, but the kill switch is now gated on a separate `killing` flag, so
  // it stays ENABLED throughout the run. Running auto-opens the live drawer.
  const { name, ctx, page } = await seed(browser, { maxRps: 2, durationSec: 10 });

  const cctx = await browser.newContext();
  const ciso = await cctx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await card(ciso, name).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, name).getByText('Approved')).toBeVisible();

  await page.reload();
  await goTo(page, 'Campaigns');
  await card(page, name).getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Launch campaign' }).click();
  // The live drawer opens; its Kill switch is enabled (not disabled by `busy`).
  const drawer = page.locator('aside.drawer');
  const kill = drawer.getByRole('button', { name: 'Kill switch' });
  await expect(kill).toBeEnabled({ timeout: 15_000 });
  await kill.click();
  await expect(drawer.locator('.kill-note')).toBeVisible({ timeout: 15_000 });
  await ctx.close();
  await cctx.close();
});

test('drawer: CISO approves from inside the drawer (modal layers above the drawer)', async ({
  browser,
}) => {
  // Regression guard for the z-index fix: the approve modal opened from the drawer
  // must sit ABOVE the drawer overlay so its Approve button is clickable.
  const { name, ctx } = await seed(browser);
  const cctx = await browser.newContext();
  const ciso = await cctx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await card(ciso, name).getByRole('button', { name: 'Details' }).click();
  const drawer = ciso.locator('aside.drawer');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(drawer.getByText('Approved')).toBeVisible();
  await ctx.close();
  await cctx.close();
});

test('campaign list: the sort select cycles recent / name / wrs', async ({ page }) => {
  await login(page, 'engineer');
  await createCampaign(page, { name: `sort-${Date.now()}`, target: SELF, probe: SELF });
  await goTo(page, 'Campaigns');
  const sort = page.locator('select:has(option[value="wrs"])').first();
  await sort.selectOption('wrs');
  await expect(sort).toHaveValue('wrs');
  await sort.selectOption('name');
  await expect(sort).toHaveValue('name');
  await sort.selectOption('recent');
  await noError(page);
});

test('suite: an engineer composes a one-template suite (pending approval)', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  await page.locator('.field:has(label:text-is("Target for the assessment")) input').fill(SELF);
  await page.locator('input[aria-label^="Select "]').first().check();
  await page.getByRole('button', { name: /Compose into one campaign/ }).click();
  // Compose succeeds and lands the engineer back on Campaigns (the CISO, not the
  // engineer, sees "Approve scenario"; the engineer only gets the success toast).
  await expect(page.getByText(/Composed campaign created/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
  await noError(page);
});
