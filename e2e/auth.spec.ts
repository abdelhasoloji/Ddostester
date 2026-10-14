import { test, expect } from '@playwright/test';
import { login, goTo } from './helpers.js';

// A1–A3, A7 from docs/functional-test-catalog.md.

test('shows the login screen when auth is enabled (A1)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('rejects invalid credentials (A3)', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[autocomplete="username"]').fill('abdelha@wedos');
  await page.locator('input[type="password"]').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
});

test('admin signs in and reaches the shell (A2)', async ({ page }) => {
  await login(page, 'admin', { fresh: true });
  await expect(page.locator('nav.nav').getByRole('link', { name: 'Campaigns' })).toBeVisible();
});

test('deep-link refresh on /campaigns is served by the SPA fallback (A7)', async ({ page }) => {
  await login(page, 'admin');
  await goTo(page, 'Campaigns');
  await page.reload();
  // Still the app (not a 404): the Campaigns view renders after reload (role-
  // agnostic — the page heading).
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();
});

test('session persists across reload, and logout returns to the login screen (A5/A6)', async ({
  page,
}) => {
  await login(page, 'admin');
  await page.reload();
  // A5: still authenticated after reload (no re-login).
  await expect(page.locator('nav.nav').getByRole('link', { name: 'Campaigns' })).toBeVisible();
  // A6: signing out returns to the login screen.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
