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
  await eng.getByRole('button', { name: 'Launch campaign' }).click();
  // execute() blocks until the run finishes and auto-opens the live drawer. Wait
  // for the completion toast, then close the drawer so the next navigation isn't
  // intercepted by its overlay.
  await expect(eng.getByText(/Run COMPLETED/i)).toBeVisible({ timeout: 20_000 });
  await eng.keyboard.press('Escape');
  await expect(eng.locator('aside.drawer')).toHaveCount(0);
}

test('results: two completed runs — per-run View/Report, exports, share, compare', async ({
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

  // Both runs land in Results under "Measured runs".
  await goTo(eng, 'Results');
  await expect(eng.locator('.report-row', { hasText: a })).toBeVisible({ timeout: 20_000 });
  await expect(eng.locator('.report-row', { hasText: b })).toBeVisible({ timeout: 20_000 });

  // Per-run: View expands the detail, then Hide collapses it.
  const rowA = eng.locator('.report-row', { hasText: a });
  await rowA.getByRole('button', { name: 'View' }).click();
  await expect(rowA.getByRole('button', { name: 'Hide' })).toBeVisible();
  await rowA.getByRole('button', { name: 'Hide' }).click();
  // Report ↗ points at the run report.
  await expect(rowA.getByRole('link', { name: /Report/ })).toHaveAttribute('href', /.+/);

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
