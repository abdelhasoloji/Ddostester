import { test, expect, type Page } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// Results screen actions that require real completed runs: per-run View/Hide and
// Report link, the aggregated compliance report + CSV export links, the share
// link, and the before/after Compare selects (needs ≥ 2 measured runs).

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

/** Engineer creates a bounded campaign, CISO approves, engineer runs it to done. */
async function runOne(eng: Page, ciso: Page, name: string): Promise<void> {
  await createCampaign(eng, { name, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });
  await goTo(ciso, 'Campaigns');
  // Force a fresh fetch: the CISO logged in before this campaign existed, so a
  // re-navigation alone may show a stale (empty) list under a slow environment.
  await ciso.reload();
  const cisoCard = card(ciso, name);
  await expect(cisoCard).toBeVisible({ timeout: 15_000 });
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, name).getByText('Approved')).toBeVisible();
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await (await openCard(eng, name)).getByRole('button', { name: 'Run', exact: true }).click();
  await eng.getByRole('button', { name: 'Run now' }).click();
  // Launching lands on Run Theater; execute() runs to completion server-side and
  // the global completion toast fires (no card drawer to dismiss anymore).
  await expect(eng).toHaveURL(/\/theater/);
  await expect(eng.getByText(/Run COMPLETED/i)).toBeVisible({ timeout: 20_000 });
}

test('results: the cross-campaign surface — compliance exports, share, before/after compare', async ({
  browser,
}) => {
  test.slow(); // two real runs + settle time
  const engCtx = await browser.newContext();
  await engCtx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');

  const a = `res-a-${Date.now()}`;
  const b = `res-b-${Date.now()}`;
  await runOne(eng, ciso, a);
  await runOne(eng, ciso, b);

  // Results is the CROSS-campaign surface (per-run detail lives on Campaigns);
  // retired from the nav but reachable by URL.
  await eng.goto('/reports');

  // Aggregated compliance exports.
  await expect(eng.getByRole('link', { name: /Open compliance report/ })).toHaveAttribute(
    'href',
    /compliance/,
  );
  await expect(eng.getByRole('link', { name: /Export runs CSV/ })).toHaveAttribute(
    'href',
    /runs\.csv/,
  );

  // Share link (mints a read-only token, copies it).
  await eng.getByRole('button', { name: /Copy share link/ }).click();
  await expect(eng.getByText(/link copied/i)).toBeVisible();

  // Compare (before/after) — two runs present, so the selects render.
  await expect(eng.getByLabel('Run A (before)')).toBeVisible();
  const runB = eng.getByLabel('Run B (after)');
  await expect(runB).toBeVisible();
  await noError(eng);

  await engCtx.close();
  await cisoCtx.close();
});
