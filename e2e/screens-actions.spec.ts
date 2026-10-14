import { test, expect, type Page } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// Exhaustive-ish coverage of the CLICKABLE actions on every screen (not just the
// API): every nav section renders, tabs switch, list filters/search/sort work,
// templates select+compose, settings controls, modals open+close, and the full
// two-step SUITE controls (approve → run → cancel) driven from the UI.

// Prepare + Results retired from the nav; the audit log moved into Settings.
const SECTIONS = ['Command Center', 'Campaigns', 'Run Theater', 'Settings'];
const MORE = ['Protected zones'];

/** No error toast is showing (a clicked action didn't blow up). */
async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

test('every nav section renders without an error (officer)', async ({ page }) => {
  await login(page, 'admin');
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

test('campaign list: status filter + search actually change the visible set', async ({ page }) => {
  const name = `filt-${Date.now()}`;
  await login(page, 'engineer');
  await createCampaign(page, { name, target: SELF, probe: SELF }); // pending
  await goTo(page, 'Campaigns');
  const filter = (f: string) =>
    page
      .getByRole('button', { name: new RegExp(`^${f}\\b`) })
      .first()
      .click();

  // Pending shows it; Done (it isn't) hides it; All shows it again — real filtering.
  await filter('Pending');
  await expect(card(page, name)).toBeVisible();
  await filter('Done');
  await expect(card(page, name)).toHaveCount(0);
  await filter('All');
  await expect(card(page, name)).toBeVisible();

  // Search narrows to the match and hides it on a non-match.
  const search = page.getByPlaceholder(/Search name/i);
  await search.fill(name);
  await expect(card(page, name)).toBeVisible();
  await search.fill(`no-such-${Date.now()}`);
  await expect(card(page, name)).toHaveCount(0);
});

test('Templates: search narrows the list, then compose bar appears on select', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  const search = page.getByPlaceholder('Search templates…');
  await expect(search).toBeVisible();
  // Wait for the catalogue to load before counting (it fetches async).
  await expect(page.locator('details.tpl-row').nth(3)).toBeVisible({ timeout: 10_000 });
  const all = await page.locator('details.tpl-row').count();
  await search.fill('bank');
  const filtered = await page.locator('details.tpl-row').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(all); // search actually narrowed the list
  await search.fill('');
  await expect(page.locator('details.tpl-row')).toHaveCount(all); // and restored it

  // Select the first template's compose checkbox → the compose bar shows.
  await page.locator('input[aria-label^="Select "]').first().check();
  await expect(page.getByRole('button', { name: /Create assessment/ })).toBeVisible();
});

test('Settings/theme: choosing dark or light applies data-theme to the document', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const buttons = page.locator('.theme-toggle button');
  await expect(buttons).toHaveCount(3); // light / system / dark
  await buttons.nth(2).click(); // dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await buttons.nth(0).click(); // light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
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
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
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
  const composeBtn = eng.getByRole('button', { name: /Create assessment/ });
  await expect(composeBtn).toBeEnabled();
  await composeBtn.click();
  await noError(eng);

  // The suite is PENDING. CISO approves the scenario.
  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  // Suites are compact table rows now; expand the suite (a row with a step count)
  // to reach its "Approve / Reject" control — aligned with a basic campaign.
  await ciso
    .locator('tr.ct-row', { has: ciso.locator('.ct-steps') })
    .first()
    .click();
  const decide = ciso.getByRole('button', { name: /Approve \/ Reject/ }).first();
  await expect(decide).toBeVisible({ timeout: 10_000 });
  await decide.click();
  // The Approve/Reject modal opens; Approve batches over the pending steps.
  const dialog = ciso.getByRole('dialog', { name: /Approve or reject assessment/i });
  await dialog.getByRole('button', { name: /^Approve \(/ }).click();
  await noError(ciso);

  // Engineer runs the approved scenario, then cancels it (the #108 fix: the
  // executor can control their own sequence).
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await eng
    .locator('tr.ct-row', { has: eng.locator('.ct-steps') })
    .first()
    .click();
  const runScenario = eng.getByRole('button', { name: /Run assessment/ }).first();
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
