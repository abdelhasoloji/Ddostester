import { test, expect, type Page } from '@playwright/test';
import { login, goTo, SELF } from './helpers.js';

// Global chrome + the read/prepare/plan screens' clickable actions that no other
// spec drives: the My-account page (chip nav, theme choice, sign out), the
// notifications panel Close control, the Prepare probe/Send-to-Plan/Copy-paths
// flow, the Plan infer/analyze controls, and the Guide "Use this configuration".

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

test('account: the identity chip opens My account; theme choice switches', async ({ page }) => {
  await login(page, 'engineer');
  await page.locator('a[href="/account"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
  // Appearance theme-choice group.
  const group = page.locator('.theme-choice');
  for (const btn of await group.getByRole('button').all()) {
    await btn.click();
    await noError(page);
  }
  // The last-clicked option is pressed AND the theme actually applied to the document.
  await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(1);
  // THEME_OPTS order is light → system → dark, so the loop ends on Dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('account: Sign out from My account returns to the login screen', async ({ page }) => {
  await login(page, 'engineer');
  await page.goto('/account');
  await page.locator('.account-signout').click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('notifications: bell opens the panel and the Close control dismisses it', async ({ page }) => {
  await login(page, 'engineer');
  await page
    .getByRole('button', { name: /Notifications/ })
    .first()
    .click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  await page.locator('[aria-label="Close notifications"]').click();
  await expect(panel).toHaveCount(0);
});

test('prepare: run recon, then Copy paths and Send to Plan', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page, 'engineer');
  await goTo(page, 'Prepare');
  // Default target is off-allowlist; use the allowlisted self target + a probe.
  // Prepare wraps each field as <label class="field"><span>Label</span><input/>.
  await page.locator('label.field:has(span:text-is("Target")) input').fill(SELF);
  await page.locator('label.field:has(span:text-is("Probe URL (optional)")) input').fill(SELF);
  await page.getByRole('button', { name: 'Run recon' }).click();
  // A report renders (preflight readiness / target profile).
  await expect(page.getByRole('heading', { name: 'Target profile' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Copy paths' }).click();
  await expect(page.getByText(/copied to the clipboard/)).toBeVisible();
  // Send to Plan navigates to the Plan tab.
  await page.getByRole('button', { name: /Send to Plan/ }).click();
  await expect(page.getByRole('tab', { name: 'Plan', selected: true })).toBeVisible();
  await noError(page);
});

test('plan: fill target, Infer from evidence and Analyze gaps', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Plan' }).click();
  const target = page.locator('input').first();
  if (await target.count()) await target.fill(SELF);
  await page.getByRole('button', { name: /Infer from evidence/ }).click();
  await noError(page);
  await page.getByRole('button', { name: /Analyze gaps/ }).click();
  // The analysis must actually produce output — a priority breakdown row.
  await expect(page.getByText(/priority to replay/)).toBeVisible({ timeout: 10_000 });
  await noError(page);
});

test('guide: "Use this configuration" queues a preset into the launch form', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'How it works' }).click();
  const use = page.getByRole('button', { name: /Use this configuration/ }).first();
  if (!(await use.count())) return; // guide has no preset buttons in this build
  await use.click();
  // The launch form opens seeded (its Submit is visible).
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible({
    timeout: 10_000,
  });
  await noError(page);
});

test('command center: in-body quick links navigate', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Command Center');
  const reports = page.getByRole('link', { name: /View reports|Results/ }).first();
  if (await reports.count()) {
    await reports.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Results' })).toBeVisible();
  }
  await noError(page);
});
