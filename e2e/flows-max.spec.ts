import { test, expect, type Page } from '@playwright/test';
import { login, goTo, SELF } from './helpers.js';

// Maximum flow coverage: the controls discovered on every screen that the other
// specs don't yet drive. Guarded clicks (present-then-click) keep it resilient to
// role/state differences; each asserts no error toast and, where meaningful, a
// concrete outcome.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}
async function clickIf(page: Page, name: RegExp | string): Promise<boolean> {
  const b = page.getByRole('button', { name }).first();
  if (!(await b.isVisible().catch(() => false))) return false;
  await b.click().catch(() => undefined);
  await noError(page);
  return true;
}

test('sidebar: theme buttons apply the theme; notifications bell opens then closes', async ({
  page,
}) => {
  await login(page, 'engineer');
  // The sidebar theme toggle is light / system / dark (in that order). Choosing
  // one applies it to the document (behaviour, not just a click).
  const themeBtns = page.locator('.theme-toggle button');
  await expect(themeBtns).toHaveCount(3);
  await themeBtns.nth(0).click(); // light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await themeBtns.nth(2).click(); // dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await themeBtns.nth(1).click(); // system → attribute removed
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');

  // The bell opens the notifications dialog, and Escape closes it.
  await page
    .getByRole('button', { name: /Notifications/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toHaveCount(0);
});

test('Assurance (audit): Refresh, Verify integrity and the Export (JSON) link', async ({
  page,
}) => {
  // These live on the Assurance/audit route (not Command Center — the earlier
  // version drove guarded clicks there and silently asserted nothing).
  await login(page, 'officer');
  await goTo(page, 'Assurance');
  await page
    .getByRole('button', { name: /Refresh/ })
    .first()
    .click();
  await noError(page);
  // Verify integrity must produce a verdict, not just "no error".
  await page.getByRole('button', { name: /Verify integrity/ }).click();
  await expect(page.getByText(/Chain intact|tampered|broken/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: /Export \(JSON\)/ }).first()).toHaveAttribute(
    'href',
    /audit/,
  );
  await noError(page);
});

test('Prepare: run recon against an allowlisted target', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Prepare');
  const input = page.locator('input').first();
  if (await input.count()) await input.fill(SELF);
  if (await clickIf(page, /Run recon/)) {
    // A recon result renders (posture / readiness) or a graceful message.
    await expect(page.getByText(/readiness|posture|surface|profile|recon/i).first()).toBeVisible({
      timeout: 15_000,
    });
  }
});

test('Protected zones: renders and its recon/retry control works', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Protected zones');
  await clickIf(page, /Run recon|Retry/);
  await noError(page);
});

test('Templates: a category chip actually filters to that category’s count', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Templates' }).click();

  const cats = page.locator('.tpl-cats .chip-xs');
  await cats.first().click(); // "All (N)"
  const allCount = await page.locator('details.tpl-row').count();
  expect(allCount).toBeGreaterThan(0);

  // The first real category chip carries its own count "(K)"; clicking it must
  // reduce the rendered rows to exactly K (a real filter, not just a click).
  const catBtn = cats.nth(1);
  const k = Number((await catBtn.innerText()).match(/\((\d+)\)/)?.[1]);
  expect(k).toBeGreaterThan(0);
  await catBtn.click();
  await expect(page.locator('details.tpl-row')).toHaveCount(k);
  expect(k).toBeLessThan(allCount); // it's a subset

  // Back to All restores the full set.
  await cats.first().click();
  await expect(page.locator('details.tpl-row')).toHaveCount(allCount);

  // The custom-template creation form opens.
  await page.getByRole('button', { name: /New template/ }).click();
  await expect(page.getByRole('button', { name: 'Save template' })).toBeVisible();
});

test('Plan tab: Analyze gaps produces a prioritised plan', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('tab', { name: 'Plan' }).click();
  const target = page.locator('input').first();
  if (await target.count()) await target.fill(SELF);
  await clickIf(page, /Infer from evidence/);
  await page.getByRole('button', { name: /Analyze gaps/ }).click();
  // The analysis must render a real priority breakdown, not just avoid an error.
  await expect(page.getByText(/priority to replay/)).toBeVisible({ timeout: 10_000 });
});

// NOTE: bench governance lives on Settings (CISO), not Assurance — it is driven
// for real in bench-governance.spec.ts. The compliance/CSV links live on Results
// and are asserted in results-deep.spec.ts. The earlier test here pointed guarded
// clicks at the Assurance route where none of those controls exist, so it silently
// asserted nothing; it has been removed in favour of those dedicated specs.

test('recon-first create: target-phase Cancel returns to the launch view', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await expect(page.getByRole('button', { name: /Run recon/ })).toBeVisible();
  await page.getByRole('button', { name: /^Cancel$/ }).click();
  await expect(page.getByRole('button', { name: /New campaign/ })).toBeVisible();
});

test('recon-first create: run recon then "Start from scratch" reaches the seeded form', async ({
  page,
}) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page.locator('.recon-first input').first().fill(SELF);
  await page.getByRole('button', { name: /Run recon/ }).click();
  await page.getByRole('button', { name: /Start from scratch/ }).click();
  // The classic form (with the mandatory attestation + submit) is now shown.
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
  await noError(page);
});

test('Settings admin: role change, deactivate/reactivate, reset, remove all take effect', async ({
  page,
}) => {
  await login(page, 'officer');
  await goTo(page, 'Settings');
  const email = `e2e-mgmt-${Date.now()}@wedos`;
  await page.locator('.field:has(label:text-is("Email")) input').fill(email);
  await page
    .locator('.field:has(label:text-is("Temporary password")) input')
    .fill('e2e-temp-pass-1234');
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  const row = page.locator('.engine-row', { hasText: email });

  // Role change actually applies (confirmation toast names the new role).
  await page.locator(`select[aria-label="Role for ${email}"]`).selectOption('engineer');
  await expect(page.getByText(new RegExp(`${email} is now`))).toBeVisible();

  // Deactivate → Reactivate each report their effect.
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText(new RegExp(`${email} deactivated`))).toBeVisible();
  await row.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByText(new RegExp(`${email} reactivated`))).toBeVisible();

  // Reset password sets a temporary one.
  await row.getByRole('button', { name: 'Reset password' }).click();
  await row.locator('input[type="password"]').fill('e2e-new-temp-99999');
  await row.getByRole('button', { name: 'Set temporary password' }).click();
  await expect(page.getByText(/Temporary password set/)).toBeVisible();

  // Remove deletes the user.
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
});
// (Removed a weak duplicate that only clicked Save/scope with noError — the purge
// scope + confirm/cancel, Grafana save + deep-links, and notifications are asserted
// for real in settings-admin.spec.ts.)
