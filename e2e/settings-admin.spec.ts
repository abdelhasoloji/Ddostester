import { test, expect, type Page } from '@playwright/test';
import { login, goTo } from './helpers.js';

// Admin-only Settings cards (officer → admin): operational limits save, the purge
// destructive confirm/cancel, the Grafana observability link, and the per-user
// role-change + reset-password inline cancel that the other specs capture but
// never actually drive.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

test('settings: operational limits change actually persists (survives a reload)', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const durSel =
    '.card:has-text("Operational limits") .field:has(label:has-text("Max duration")) input';
  // 800s: distinct from the 900 ceiling (so it proves a real write) and ≥ every
  // duration other specs use (2s), so it can't break them.
  await page.locator(durSel).fill('800');
  await page
    .locator('.card', { hasText: 'Operational limits' })
    .getByRole('button', { name: 'Save limits' })
    .click();
  await expect(page.getByText(/Operational limits updated/)).toBeVisible();

  // Reload: the form re-initialises from /health's effective caps, so the value
  // only survives if the write actually took effect server-side.
  await page.reload();
  await goTo(page, 'Settings');
  await expect(page.locator(durSel)).toHaveValue('800');
  await noError(page);
});

test('settings: purge card — scope select + Purge… reveals confirm, then Cancel (no delete)', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const card = page.locator('.card', { hasText: 'Purge campaigns' });
  const scope = card.locator('select[aria-label="Purge scope"]');
  await scope.selectOption('all');
  await expect(scope).toHaveValue('all');
  await scope.selectOption('settled');
  await card.getByRole('button', { name: 'Purge…' }).click();
  // The confirm affordance appears; we deliberately Cancel (never delete in e2e).
  await expect(card.getByRole('button', { name: 'Confirm purge' })).toBeVisible();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: 'Purge…' })).toBeVisible();
  await noError(page);
});

test('settings: observability — save a Grafana base URL, deep-links appear', async ({ page }) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const card = page.locator('.card', { hasText: 'Observability (Grafana)' });
  await card.locator('#grafana-url').fill('http://localhost:3000');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Grafana URL saved.')).toBeVisible();
  await expect(card.getByRole('link', { name: /Run & Absorption/ })).toBeVisible();
  await noError(page);
});

test('settings: users — add, change role via row select, reset-password Cancel, remove', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const email = `e2e-role-${Date.now()}@wedos`;
  await page.locator('.field:has(label:text-is("Email")) input').fill(email);
  await page
    .locator('.field:has(label:text-is("Temporary password")) input')
    .fill('e2e-temp-pass-1234');
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText(email, { exact: true }).first()).toBeVisible();

  // Change the new user's role via its row select.
  const roleSelect = page.locator(`select[aria-label="Role for ${email}"]`);
  await roleSelect.selectOption('engineer');
  await expect(page.getByText(new RegExp(`${email.replace('.', '\\.')} is now`))).toBeVisible();

  // Reset password: open the inline form then Cancel it (no side effect).
  const row = page.locator('.engine-row', { hasText: email });
  await row.getByRole('button', { name: 'Reset password' }).click();
  await expect(row.locator('input[type="password"]')).toBeVisible();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.locator('input[type="password"]')).toHaveCount(0);

  // Cleanup.
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  await noError(page);
});
