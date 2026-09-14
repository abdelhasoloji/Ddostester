import { test, expect, type Page } from '@playwright/test';
import { login, goTo, SELF } from './helpers.js';

// Exhaustive coverage of the New-campaign classic form (NewCampaignForm), reached
// through the one recon-first entry point. The other specs only ever fill the six
// mandatory fields via the helper; here every optional control is driven: presets,
// vector→POST body, the load-shape selects, the realism/SLO block, and the toggles
// (cache-bust / no-keep-alive / parallelism / concurrency), then the form submits.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

/** New campaign → target → Run recon → Compose → the seeded classic form. */
async function openComposeForm(page: Page): Promise<void> {
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page.locator('.recon-first input').first().fill(SELF);
  await page.getByRole('button', { name: /Run recon/ }).click();
  await page.getByRole('button', { name: /Compose from these findings/ }).click();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
}

const field = (page: Page, label: string) =>
  page.locator(`.field:has(label:text-is("${label}")) input`);

/** Fill the mandatory fields so the form is submittable. */
async function fillMandatory(page: Page, name: string): Promise<void> {
  await field(page, 'Name').fill(name);
  // Target + Probe are pre-seeded from recon (SELF, allowlisted); set caps.
  await field(page, 'Max RPS').fill('5');
  await field(page, 'Max duration (s)').fill('2');
  await page.locator('label.attest input[type="checkbox"]').check();
}

test('form: a preset chip applies its load shape (chip becomes active)', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const chip = page.locator('.presets-row .chip').first();
  await chip.click();
  await expect(chip).toHaveClass(/chip-active/);
  await noError(page);
});

test('form: vector → http-post reveals the POST body textarea', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  await page.locator('.field:has(label:text-is("Vector")) select').selectOption('http-post');
  await expect(
    page.locator('.field:has(label:text-is("Request body (POST)")) textarea'),
  ).toBeVisible();
  // Switching back hides it.
  await page.locator('.field:has(label:text-is("Vector")) select').selectOption('http-get');
  await expect(
    page.locator('.field:has(label:text-is("Request body (POST)")) textarea'),
  ).toHaveCount(0);
});

test('form: toggles (cache-bust, no-keep-alive, parallelism, concurrency) then submit', async ({
  page,
}) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const name = `form-toggles-${Date.now()}`;
  // Cache-busting + no keep-alive checkboxes.
  await page.locator('.cachebust-toggle', { hasText: 'Cache-busting' }).locator('input').check();
  await page.locator('.cachebust-toggle', { hasText: 'No keep-alive' }).locator('input').check();
  // Parallel generation number (clamped 1–8) and Concurrency.
  await page
    .locator('.cachebust-toggle', { hasText: 'Parallel generation' })
    .locator('input')
    .fill('4');
  await field(page, 'Concurrency').fill('10');
  await fillMandatory(page, name);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await noError(page);
});

test('form: load-shape selects (profile / engine / schedule / repeat)', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const shape = page.locator('details.form-section', { hasText: 'Load shape & scheduling' });
  await shape.locator('.field:has(label:text-is("Load profile")) select').selectOption('ramp');
  // Load engine: server default is always present as the first option value "".
  await shape.locator('.field:has(label:text-is("Load engine")) select').selectOption('');
  await shape
    .locator('.field:has(label:text-is("Repeat every (optional)")) select')
    .selectOption('60');
  await shape
    .locator('.field:has(label:text-is("Schedule (optional)")) input[type="datetime-local"]')
    .fill('2030-01-01T10:00');
  await noError(page);
});

test('form: advanced realism & acceptance — SLO, assertion, endpoint mix, UA, dataset', async ({
  page,
}) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const name = `form-realism-${Date.now()}`;
  const adv = page.locator('details.form-section', { hasText: 'Advanced realism & acceptance' });
  await adv.locator('summary').click();
  // SLO acceptance grid (four/five number inputs by placeholder).
  await adv.getByPlaceholder('max p95 ms').fill('800');
  await adv.getByPlaceholder('max errors %').fill('5');
  await adv.getByPlaceholder('min avail %').fill('95');
  await adv.getByPlaceholder('min WRS').fill('70');
  // Response assertion (builtin engine).
  await adv.getByPlaceholder('expected status').fill('200');
  await adv.getByPlaceholder('body contains…').fill('ok');
  // Endpoint mix + UA rotation + dataset feeder.
  await page
    .locator(
      '.field:has(label:text-is("Endpoint mix — spread load over several URLs (optional)")) textarea',
    )
    .fill(`${SELF} 3\n${SELF} 1`);
  await page
    .locator(
      '.field:has(label:text-is("User-Agent rotation — client diversity (optional)")) textarea',
    )
    .fill('Mozilla/5.0 (E2E)\nMozilla/5.0 (E2E-2)');
  await page
    .locator('.field:has(label:text-is("Data feeder — parameterized traffic (optional)")) textarea')
    .fill('q,id\napple,101');
  await fillMandatory(page, name);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await noError(page);
});

test('form: an allowed-host chip fills the target field', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const targetField = page.locator('.field:has(label:text-is("Target (URL)"))');
  await targetField.locator('.allowed-chips .chip-xs').first().click();
  await expect(targetField.locator('input')).not.toHaveValue('');
  await noError(page);
});

test('form: Cancel returns to the recon-first launch view', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  // The classic form's own Cancel (rendered because onDone is passed).
  await page
    .locator('section.card', { hasText: 'New campaign' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByRole('button', { name: /New campaign/ })).toBeVisible();
});

test('form: "← Back to recon" from the compose step returns to the recon summary', async ({
  page,
}) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  await page.getByRole('button', { name: /Back to recon/ }).click();
  await expect(page.getByRole('button', { name: /Compose from these findings/ })).toBeVisible();
  // And "← Change target" from there returns to the target input.
  await page.getByRole('button', { name: /Change target/ }).click();
  await expect(page.getByRole('button', { name: /Run recon/ })).toBeVisible();
});
