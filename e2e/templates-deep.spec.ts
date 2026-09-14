import { test, expect, type Page } from '@playwright/test';
import { login, goTo } from './helpers.js';

// Deep coverage of the Templates tab controls the other specs don't drive: the
// custom-template create → save → expand → delete lifecycle, the single-template
// "Launch assessment" path, the compose-basket chip removal + name, the row
// expander, and the launch-bar repeat select.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

async function openTemplates(page: Page): Promise<void> {
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(page.getByPlaceholder('Search templates…')).toBeVisible();
}

test('templates: create a custom template, expand it, then delete it', async ({ page }) => {
  await login(page, 'engineer');
  await openTemplates(page);
  const name = `e2e-tpl-${Date.now()}`;
  await page.getByRole('button', { name: /New template/ }).click();
  await page.locator('.field:has(label:text-is("Name")) input').fill(name);
  await page
    .locator('.field:has(label:text-is("Steps (JSON)")) textarea')
    .fill(
      '[{"name":"Baseline","maxRps":10,"concurrency":5,"maxDurationSec":5,"profile":"constant"}]',
    );
  await page.getByRole('button', { name: 'Save template' }).click();
  // The new template appears as a row (and is flagged custom).
  const row = page.locator('details.tpl-row', { hasText: name });
  await expect(row.getByText(name, { exact: true })).toBeVisible();
  await noError(page);

  // Expand the row → its step list renders.
  await row.locator('summary').click();
  await expect(row.locator('.playbook-steps')).toBeVisible();

  // Delete → Confirm.
  await row.getByRole('button', { name: 'Delete' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('details.tpl-row', { hasText: name })).toHaveCount(0);
  await noError(page);
});

test('templates: custom-template delete Cancel keeps the template', async ({ page }) => {
  await login(page, 'engineer');
  await openTemplates(page);
  const name = `e2e-tpl-keep-${Date.now()}`;
  await page.getByRole('button', { name: /New template/ }).click();
  await page.locator('.field:has(label:text-is("Name")) input').fill(name);
  await page
    .locator('.field:has(label:text-is("Steps (JSON)")) textarea')
    .fill('[{"name":"S","maxRps":5,"concurrency":2,"maxDurationSec":3,"profile":"constant"}]');
  await page.getByRole('button', { name: 'Save template' }).click();
  const row = page.locator('details.tpl-row', { hasText: name });
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Delete' }).click();
  await row.getByRole('button', { name: 'Cancel' }).click();
  // Still present.
  await expect(row.getByText(name, { exact: true })).toBeVisible();
  await noError(page);
});

test('templates: launch a single template against an allowlisted target', async ({ page }) => {
  await login(page, 'engineer');
  await openTemplates(page);
  // Pick an allowlisted target via the launch-bar chip.
  await page.locator('.tpl-launchbar .allowed-chips .chip-xs').first().click();
  // Expand the first template row and launch it.
  const row = page.locator('details.tpl-row').first();
  await row.locator('summary').click();
  await row.getByRole('button', { name: /Launch assessment \(/ }).click();
  // Instantiating navigates to Campaigns; a success toast confirms creation.
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
  await expect(page.locator('.toast, .toast-success').first()).toBeVisible();
  await noError(page);
});

test('templates: launch-bar repeat select changes', async ({ page }) => {
  await login(page, 'engineer');
  await openTemplates(page);
  const repeat = page.locator(
    '.tpl-launchbar .field:has(label:text-is("Repeat (optional)")) select',
  );
  await repeat.selectOption('60');
  await expect(repeat).toHaveValue('60');
  await repeat.selectOption('');
  await noError(page);
});

test('templates: compose basket — select two, remove one via its chip ×, name it', async ({
  page,
}) => {
  await login(page, 'engineer');
  await openTemplates(page);
  // Need an allowlisted target for the compose button to enable.
  await page.locator('.tpl-launchbar .allowed-chips .chip-xs').first().click();
  const boxes = page.locator('input[aria-label^="Select "]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  // Two chips in the basket.
  await expect(page.locator('.tcb-chip')).toHaveCount(2);
  await page.locator('.tcb-name').fill('e2e-suite-name');
  // Remove the first chip via its × (aria-label "Remove <name>").
  await page.locator('.tcb-chip .tcb-x').first().click();
  await expect(page.locator('.tcb-chip')).toHaveCount(1);
  await noError(page);
});
