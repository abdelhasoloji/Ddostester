import { test, expect, type Page } from '@playwright/test';
import { login, goTo, openCard, SELF } from './helpers.js';

// Exhaustive coverage of the New-campaign classic form (NewCampaignForm), reached
// through the one recon-first entry point. The other specs only ever fill the six
// mandatory fields via the helper; here every optional control is driven: presets,
// vector→POST body, the load-shape selects, the realism/SLO block, and the toggles
// (cache-bust / no-keep-alive / parallelism / concurrency), then the form submits.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

/** New campaign → target → Profile target → Compose → the seeded classic form. */
async function openComposeForm(page: Page): Promise<void> {
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page.locator('.recon-first input').first().fill(SELF);
  await page.getByRole('button', { name: /Profile target/ }).click();
  await page.getByRole('button', { name: /Use these findings/ }).click();
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

  // Verify the config actually persisted (not just that submit worked): the
  // Details drawer's Load line reflects the concurrency we set.
  await (await openCard(page, name)).getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('aside.drawer')).toContainText('10 conc');
  await noError(page);
});

test('form: load-shape selects (profile / engine / schedule / repeat)', async ({ page }) => {
  await login(page, 'engineer');
  await openComposeForm(page);
  const shape = page.locator('details.form-section', { hasText: 'Load shape & scheduling' });
  const profile = shape.locator('.field:has(label:text-is("Load profile")) select');
  const repeat = shape.locator('.field:has(label:text-is("Repeat every (optional)")) select');
  const schedule = shape.locator(
    '.field:has(label:text-is("Schedule (optional)")) input[type="datetime-local"]',
  );
  await profile.selectOption('ramp');
  await repeat.selectOption('60');
  await schedule.fill('2030-01-01T10:00');
  // The selects actually hold what we set (the control took the value).
  await expect(profile).toHaveValue('ramp');
  await expect(repeat).toHaveValue('60');
  await expect(schedule).toHaveValue('2030-01-01T10:00');
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
  // The inputs actually hold what we typed (the acceptance/realism controls work).
  await expect(adv.getByPlaceholder('max p95 ms')).toHaveValue('800');
  await expect(adv.getByPlaceholder('min WRS')).toHaveValue('70');
  await expect(
    page.locator(
      '.field:has(label:text-is("Endpoint mix — spread load over several URLs (optional)")) textarea',
    ),
  ).toHaveValue(new RegExp(SELF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  await expect(page.getByRole('button', { name: /Use these findings/ })).toBeVisible();
  // And "← Change target" from there returns to the target input.
  await page.getByRole('button', { name: /Change target/ }).click();
  await expect(page.getByRole('button', { name: /Profile target/ })).toBeVisible();
});

test('recon levers: the recon step surfaces delivery levers, and a checked lever CARRIES into the form', async ({
  page,
}) => {
  // The recon-driven ergonomics: recon turns its signals into delivery levers the
  // operator toggles BEFORE launching. This asserts the outcome (the lever changes
  // the composed campaign's config), not just that the checkbox is clickable.
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page.locator('.recon-first input').first().fill(SELF);
  await page.getByRole('button', { name: /Profile target/ }).click();

  // The levers checklist renders with the recon-derived levers.
  await expect(page.getByText('Delivery levers')).toBeVisible();
  const lever = (name: string) =>
    page.locator('.recon-levers .lever', { hasText: name }).locator('input[type="checkbox"]');
  await expect(lever('Cache-busting')).toBeVisible();
  await expect(lever('Auto-calibrate rate')).toBeVisible();
  await expect(lever('User-Agent rotation')).toBeVisible();
  // SELF is a bare target (no WAF/CDN/rate-limiter) → nothing recommended, all off.
  await expect(lever('Cache-busting')).not.toBeChecked();
  await expect(lever('Auto-calibrate rate')).not.toBeChecked();

  // The operator opts two levers in, then composes.
  await lever('Cache-busting').check();
  await lever('Auto-calibrate rate').check();
  await page.getByRole('button', { name: /Use these findings/ }).click();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();

  // The chosen levers are reflected in the launch form's actual config.
  await expect(
    page.locator('.cachebust-toggle', { hasText: 'Cache-busting' }).locator('input'),
  ).toBeChecked();
  await expect(
    page.locator('.cachebust-toggle', { hasText: 'Auto-calibrate rate' }).locator('input'),
  ).toBeChecked();
  // A lever left OFF stays off in the form (no accidental enablement).
  await expect(
    page.locator('.cachebust-toggle', { hasText: 'No keep-alive' }).locator('input'),
  ).not.toBeChecked();
});
