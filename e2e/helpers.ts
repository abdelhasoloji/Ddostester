import { expect, type Page } from '@playwright/test';
import { ROLES, type RoleName } from './roles.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A dedicated target process, separate from the control plane's API.
export const SELF = 'http://127.0.0.1:8100/health';

/** Log in as a role and wait for the authenticated shell (nav) to appear. */
export async function login(
  page: Page,
  role: RoleName,
  options: { fresh?: boolean } = {},
): Promise<void> {
  const { email, password } = ROLES[role];
  const cache =
    process.env.E2E_SESSION_CACHE && join(process.env.E2E_SESSION_CACHE, role + '.json');
  if (cache && !options.fresh) {
    const saved = await readFile(cache, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const origin = saved?.origins?.find(
      (entry: { origin: string }) => entry.origin === 'http://127.0.0.1:8099',
    );
    const token = origin?.localStorage?.find(
      (entry: { name: string }) => entry.name === 'token',
    )?.value;
    if (token) {
      const response = await page.request.get('/api/auth/me', {
        headers: { authorization: 'Bearer ' + token },
      });
      const identity = response.ok() ? await response.json() : null;
      if (identity?.email === email && identity?.role === role) {
        await page.context().addCookies(saved.cookies);
        await page.goto('/');
        await page.evaluate((value) => localStorage.setItem('token', value), token);
        await page.reload();
        await expect(
          page.locator('nav.nav').getByRole('link', { name: 'Campaigns' }),
        ).toBeVisible();
        return;
      }
    }
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Shell loaded: the sidebar nav is present (scope to it — the v2 home also has
  // "Campaigns" links in the page body).
  await expect(page.locator('nav.nav').getByRole('link', { name: 'Campaigns' })).toBeVisible();
  if (cache)
    await writeFile(cache, JSON.stringify(await page.context().storageState()), { mode: 0o600 });
}

/** Go to a nav section by its visible label ("Campaigns", "Reports", ...).
 *  Campaigns is the primary destination; every other section lives under the
 *  collapsible "More" group, so reveal it first when the link is not visible. */
export async function goTo(page: Page, label: string): Promise<void> {
  // Scope to the sidebar nav so labels resolve uniquely (v2 page bodies can also
  // contain links whose accessible name matches a nav label, e.g. "Campaigns").
  const link = page.locator('nav.nav').getByRole('link', { name: label });
  if (!(await link.isVisible().catch(() => false))) {
    const more = page.getByRole('button', { name: /More/ });
    if (await more.count()) await more.first().click();
    await expect(link).toBeVisible();
  }
  await link.click();
}

/**
 * Create a bounded campaign via the UI form and submit it for approval.
 * Returns the campaign name (unique) so callers can find its card later.
 */
export async function createCampaign(
  page: Page,
  opts: {
    name?: string;
    target?: string;
    probe?: string;
    maxRps?: number;
    concurrency?: number;
    durationSec?: number;
  } = {},
): Promise<string> {
  const name = opts.name ?? `e2e-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const target = opts.target ?? SELF;
  const probe = opts.probe ?? SELF;
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();

  // The single recon-first creation flow: enter a target, run recon, then open one
  // recon-suggested action in the full editor. Playwright auto-waits for each step.
  await page.locator('.recon-first input').first().fill(target); // Target URL
  await page.getByRole('button', { name: /Profile target/ }).click();
  await page
    .getByRole('button', { name: /Open in editor/ })
    .first()
    .click(); // → classic form

  // Labels aren't for-associated in this form, so scope by the field's label text.
  await page.locator('.field:has(label:text-is("Name")) input').fill(name);
  await page.locator('.field:has(label:text-is("Target (URL)")) input').fill(target);
  await page.locator('.field:has(label:text-is("Probe (URL)")) input').fill(probe);
  await page.locator('.field:has(label:text-is("Max RPS")) input').fill(String(opts.maxRps ?? 5));
  if (opts.concurrency !== undefined)
    await page
      .locator('.field:has(label:text-is("Concurrency")) input')
      .fill(String(opts.concurrency));
  await page
    .locator('.field:has(label:text-is("Max duration (s)")) input')
    .fill(String(opts.durationSec ?? 2));

  // Authorization attestation is mandatory.
  await page.locator('label.attest input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Submit for approval' }).click();

  // The new campaign appears as a card.
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  return name;
}

/**
 * The compact campaign table ROW for a given name — carries the name, status
 * badge and WRS, so it answers visibility / status-text / count assertions
 * directly. Action buttons live in the expandable detail: use `openCard` for
 * those.
 */
export function card(page: Page, name: string) {
  return page.locator('tr.ct-row', { hasText: name });
}

/**
 * Expand a campaign's table row and return its full CampaignCard (`.campaign`)
 * for the per-campaign action buttons (Approve / Run / Archive / Details / …).
 * Idempotent-ish: only clicks to open when the detail isn't already showing.
 */
export async function openCard(page: Page, name: string) {
  const detail = page.locator('tr.ct-detail .campaign', { hasText: name });
  if ((await detail.count()) === 0) await card(page, name).click();
  await detail.first().waitFor({ state: 'visible' });
  return detail.first();
}
