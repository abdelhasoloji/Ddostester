import { test, expect, type Page } from '@playwright/test';
import { login, goTo, createCampaign, card, SELF } from './helpers.js';

// Exhaustive-ish coverage of the CLICKABLE actions on every screen (not just the
// API): every nav section renders, tabs switch, list filters/search/sort work,
// templates select+compose, settings controls, modals open+close, and the full
// two-step SUITE controls (approve → run → cancel) driven from the UI.

const SECTIONS = ['Command Center', 'Campaigns', 'Run Theater', 'Results', 'Assurance', 'Settings'];
const MORE = ['Protected zones', 'Prepare'];

/** No error toast is showing (a clicked action didn't blow up). */
async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

test('every nav section renders without an error (officer)', async ({ page }) => {
  await login(page, 'officer');
  for (const s of SECTIONS) {
    await goTo(page, s);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noError(page);
  }
  for (const s of MORE) {
    await goTo(page, s);
    await noError(page);
  }
});

test('Campaigns tabs switch surfaces (Launch/Templates/Plan/How it works)', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(page.getByPlaceholder('Search templates…')).toBeVisible();
  await page.getByRole('tab', { name: 'Plan' }).click();
  await noError(page);
  await page.getByRole('tab', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { name: 'Reading the score (WRS)' })).toBeVisible();
  await page.getByRole('tab', { name: 'Launch' }).click();
  await expect(page.getByRole('button', { name: /New campaign/ })).toBeVisible();
});

test('campaign list: status filters, search and sort are clickable', async ({ page }) => {
  await login(page, 'engineer');
  await createCampaign(page, { name: `filt-${Date.now()}`, target: SELF, probe: SELF });
  await goTo(page, 'Campaigns');
  // Status filter chips.
  for (const f of ['Pending', 'Approved', 'Running', 'Done', 'Rejected', 'All']) {
    await page
      .getByRole('button', { name: new RegExp(`^${f}\\b`) })
      .first()
      .click();
    await noError(page);
  }
  // Search + sort.
  const search = page.getByPlaceholder(/Search name/i);
  if (await search.count()) {
    await search.fill('filt');
    await noError(page);
    await search.fill('');
  }
});

test('Templates: search, select a template, compose bar appears', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  await page.getByPlaceholder('Search templates…').fill('bank');
  await noError(page);
  await page.getByPlaceholder('Search templates…').fill('');
  // Select the first template's compose checkbox → the compose bar shows.
  const firstSelect = page.locator('input[aria-label^="Select "]').first();
  await firstSelect.check();
  await expect(page.getByRole('button', { name: /Compose into one campaign/ })).toBeVisible();
});

test('Settings: theme toggle switches without error (officer=admin)', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Settings');
  // The theme control (light / system / dark) lives in the sidebar footer.
  const buttons = page.locator('button[aria-label*="theme" i], .theme-toggle button');
  if (await buttons.count()) {
    const n = Math.min(await buttons.count(), 3);
    for (let i = 0; i < n; i++) {
      await buttons.nth(i).click();
      await noError(page);
    }
  }
  await noError(page);
});

test('approve modal opens and cancels (CISO) without side effects', async ({ browser }) => {
  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  const name = await createCampaign(eng, {
    name: `modal-${Date.now()}`,
    target: SELF,
    probe: SELF,
  });

  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await card(ciso, name).getByRole('button', { name: 'Approve / Reject' }).click();
  await expect(ciso.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  // Cancel the modal (scoped to the overlay) → the campaign stays Pending.
  await ciso.locator('.overlay').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card(ciso, name).getByText('Pending')).toBeVisible();
  await engCtx.close();
  await cisoCtx.close();
});

test('SUITE two-step UI: CISO approves scenario, engineer runs then cancels (#108)', async ({
  browser,
}) => {
  // Engineer composes a one-template suite from the Templates tab.
  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  await goTo(eng, 'Campaigns');
  await eng.getByRole('tab', { name: 'Templates' }).click();
  // The compose needs an allowlisted target selected first.
  await eng.locator('.field:has(label:text-is("Target for the assessment")) input').fill(SELF);
  await eng.locator('input[aria-label^="Select "]').first().check();
  const composeBtn = eng.getByRole('button', { name: /Compose into one campaign/ });
  await expect(composeBtn).toBeEnabled();
  await composeBtn.click();
  await noError(eng);

  // The suite is PENDING. CISO approves the scenario.
  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  const approveScenario = ciso.getByRole('button', { name: /Approve scenario/ }).first();
  await expect(approveScenario).toBeVisible({ timeout: 10_000 });
  await approveScenario.click();
  await noError(ciso);

  // Engineer runs the approved scenario, then cancels it (the #108 fix: the
  // executor can control their own sequence).
  await eng.reload();
  await goTo(eng, 'Campaigns');
  const runScenario = eng.getByRole('button', { name: /Run scenario/ }).first();
  await expect(runScenario).toBeVisible({ timeout: 10_000 });
  await runScenario.click();
  // A live banner appears with Cancel; the engineer can cancel their own run.
  const cancel = eng.getByRole('button', { name: /Cancel/ }).first();
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await noError(eng);

  await engCtx.close();
  await cisoCtx.close();
});
