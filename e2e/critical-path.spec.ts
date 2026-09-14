import { test, expect } from '@playwright/test';

// Browser-level smoke: the built SPA is served, authentication works, and the
// authenticated shell reaches the API — the wiring that unit/integration tests
// can't see. The full campaign workflow is covered by the API integration tests.

test('serves the SPA, authenticates and reaches the campaigns view', async ({ page }) => {
  await page.goto('/');

  // Auth is enabled → the login screen renders.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.locator('input[autocomplete="username"]').fill('eng@wedos');
  await page.locator('input[type="password"]').fill('engineer-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Authenticated shell: the nav is present; the Campaigns view offers creation
  // (the engineer has campaign:create), proving the UI talked to /health + /api.
  await page.locator('nav.nav').getByRole('link', { name: 'Campaigns' }).click();
  await expect(page.getByRole('button', { name: /New campaign/ })).toBeVisible();
});

test('rejects invalid credentials', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[autocomplete="username"]').fill('off@wedos');
  await page.locator('input[type="password"]').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
});
